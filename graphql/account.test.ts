import assert from "node:assert/strict";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import * as vocab from "@fedify/vocab";
import { execute, parse } from "graphql";
import sharp from "sharp";
import { updateAccountData } from "@hackerspub/models/account";
import { createMediumFromBytes } from "@hackerspub/models/medium";
import { mediumTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import type { UserContext } from "./builder.ts";
import { schema } from "./mod.ts";
import { putProfileOgImage } from "./og.ts";
import {
  createFedCtx,
  createTestDisk,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const viewerQuery = parse(`
  query Viewer {
    viewer {
      username
      name
      handle
    }
  }
`);

const accountByUsernameQuery = parse(`
  query AccountByUsername($username: String!) {
    accountByUsername(username: $username) {
      username
      name
      handle
    }
  }
`);

const accountOgImageUrlQuery = parse(`
  query AccountOgImageUrl($username: String!) {
    accountByUsername(username: $username) {
      ogImageUrl
    }
  }
`);

const accountsOgImageUrlQuery = parse(`
  query AccountsOgImageUrl {
    accounts {
      ogImageUrl
    }
  }
`);

const invitationTreeQuery = parse(`
  query InvitationTree {
    invitationTree {
      id
      username
      name
      avatarUrl
      inviterId
      hidden
    }
  }
`);

const updateAccountMutation = parse(`
  mutation UpdateAccount($input: UpdateAccountInput!) {
    updateAccount(input: $input) {
      account {
        username
        bio
        locales
        preferAiSummary
        defaultNoteVisibility
        defaultShareVisibility
      }
    }
  }
`);

const smallPngDataUrl = "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createOgTestDisk(): {
  disk: UserContext["disk"];
  putKeys: string[];
  deleteKeys: string[];
} {
  const putKeys: string[] = [];
  const deleteKeys: string[] = [];
  return {
    putKeys,
    deleteKeys,
    disk: {
      getUrl(key: string) {
        if (key === "avatar-og-test") return Promise.resolve(smallPngDataUrl);
        return Promise.resolve(`http://localhost/media/${key}`);
      },
      put(key: string) {
        putKeys.push(key);
        return Promise.resolve(undefined);
      },
      delete(key: string) {
        deleteKeys.push(key);
        return Promise.resolve(undefined);
      },
    } as unknown as UserContext["disk"],
  };
}

test("putProfileOgImage leaves existing cached images for the caller", async () => {
  const disk = createOgTestDisk();

  const key = await putProfileOgImage(disk.disk, "og/v2/stale-profile.png", {
    avatarKey: "avatar-og-test",
    avatarUrl: smallPngDataUrl,
    bio: "Cached profile image should survive until metadata is updated.",
    displayName: "Profile Cache Review",
    handle: "@profilecache@localhost",
  });

  assert.match(key, /^og\/v2\/.+\.png$/);
  assert.notEqual(key, "og/v2/stale-profile.png");
  assert.deepEqual(disk.deleteKeys, []);
});

test("viewer returns the signed-in account and null for guests", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "viewerquery",
      name: "Viewer Query",
      email: "viewerquery@example.com",
    });

    const signedInResult = await execute({
      schema,
      document: viewerQuery,
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(signedInResult.errors, undefined);
    assert.deepEqual(
      toPlainJson(signedInResult.data),
      {
        viewer: {
          username: "viewerquery",
          name: "Viewer Query",
          handle: "@viewerquery@localhost",
        },
      },
    );

    const guestResult = await execute({
      schema,
      document: viewerQuery,
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(guestResult.errors, undefined);
    assert.deepEqual(toPlainJson(guestResult.data), { viewer: null });
  });
});

test("Account.ogImageUrl renders and reuses a cached profile image", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "profileoggraphql",
      name: "Profile OG GraphQL",
      email: "profileoggraphql@example.com",
    });
    const [avatarMedium] = await tx.insert(mediumTable).values({
      id: generateUuidV7(),
      key: "avatar-og-test",
      type: "image/webp",
      width: null,
      height: null,
    }).returning();
    const updated = await updateAccountData(tx, {
      id: account.account.id,
      avatarMediumId: avatarMedium.id,
      bio: "Mixed script bio: Hello, 안녕하세요, こんにちは, 你好, 😀",
      ogImageKey: "og/v2/stale-profile.png",
    });
    assert.ok(updated != null);

    const disk = createOgTestDisk();
    const firstResult = await execute({
      schema,
      document: accountOgImageUrlQuery,
      variableValues: { username: account.account.username },
      contextValue: makeGuestContext(tx, { disk: disk.disk }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(firstResult.errors, undefined);
    const firstUrl = (toPlainJson(firstResult.data) as {
      accountByUsername: { ogImageUrl: string };
    }).accountByUsername.ogImageUrl;
    assert.match(firstUrl, /^http:\/\/localhost\/media\/og\/v2\/.+\.png$/);
    assert.equal(disk.putKeys.length, 1);
    assert.deepEqual(disk.deleteKeys, []);

    const stored = await tx.query.accountTable.findFirst({
      where: { id: account.account.id },
    });
    assert.ok(stored?.ogImageKey?.startsWith("og/v2/"));

    const secondResult = await execute({
      schema,
      document: accountOgImageUrlQuery,
      variableValues: { username: account.account.username },
      contextValue: makeGuestContext(tx, { disk: disk.disk }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(secondResult.errors, undefined);
    const secondUrl = (toPlainJson(secondResult.data) as {
      accountByUsername: { ogImageUrl: string };
    }).accountByUsername.ogImageUrl;
    assert.equal(secondUrl, firstUrl);
    assert.equal(disk.putKeys.length, 1);
    assert.deepEqual(disk.deleteKeys, []);
  });
});

test("Account.ogImageUrl rejects bulk account list queries", async () => {
  await withRollback(async (tx) => {
    const disk = createOgTestDisk();
    const result = await execute({
      schema,
      document: accountsOgImageUrlQuery,
      contextValue: makeGuestContext(tx, { disk: disk.disk }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(toPlainJson(result.data), { accounts: null });
    assert.match(result.errors?.[0]?.message ?? "", /Query exceeds Complexity/);
    assert.deepEqual(disk.putKeys, []);
  });
});

test("accountByUsername returns a local account by username", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "lookupgraphql",
      name: "Lookup GraphQL",
      email: "lookupgraphql@example.com",
    });

    const result = await execute({
      schema,
      document: accountByUsernameQuery,
      variableValues: { username: account.account.username },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      accountByUsername: {
        username: "lookupgraphql",
        name: "Lookup GraphQL",
        handle: "@lookupgraphql@localhost",
      },
    });
  });
});

test("invitationTree redacts hidden accounts", async () => {
  await withRollback(async (tx) => {
    const visible = await insertAccountWithActor(tx, {
      username: "visibletree",
      name: "Visible Tree",
      email: "visibletree@example.com",
    });
    const hidden = await insertAccountWithActor(tx, {
      username: "hiddentree",
      name: "Hidden Tree",
      email: "hiddentree@example.com",
    });

    const updated = await updateAccountData(tx, {
      id: hidden.account.id,
      hideFromInvitationTree: true,
    });
    assert.ok(updated != null);

    const result = await execute({
      schema,
      document: invitationTreeQuery,
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);

    const nodes = (result.data as {
      invitationTree: Array<{
        id: string;
        username: string | null;
        name: string | null;
        avatarUrl: string;
        inviterId: string | null;
        hidden: boolean;
      }>;
    }).invitationTree;
    const visibleNode = nodes.find((node) => node.id === visible.account.id);
    const hiddenNode = nodes.find((node) => node.id === hidden.account.id);

    assert.ok(visibleNode != null);
    assert.ok(hiddenNode != null);
    assert.equal(visibleNode.hidden, false);
    assert.equal(visibleNode.username, "visibletree");
    assert.equal(visibleNode.name, "Visible Tree");

    assert.equal(hiddenNode.hidden, true);
    assert.equal(hiddenNode.username, null);
    assert.equal(hiddenNode.name, null);
    assert.equal(
      hiddenNode.avatarUrl,
      "https://gravatar.com/avatar/?d=mp&s=128",
    );
  });
});

test("updateAccount updates profile preferences for the signed-in account", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "updateaccountgraphql",
      name: "Update Account GraphQL",
      email: "updateaccountgraphql@example.com",
    });

    const fedCtx = createFedCtx(tx);
    fedCtx.getActor = (identifier: string) =>
      Promise.resolve(
        new vocab.Person({
          id: fedCtx.getActorUri(identifier),
        }),
      );

    const result = await execute({
      schema,
      document: updateAccountMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("Account", account.account.id),
          bio: "Updated profile bio",
          locales: ["ko-KR", "en-US"],
          preferAiSummary: true,
          hideFromInvitationTree: true,
          hideForeignLanguages: true,
          defaultNoteVisibility: "FOLLOWERS",
          defaultShareVisibility: "UNLISTED",
        },
      },
      contextValue: makeUserContext(tx, account.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      updateAccount: {
        account: {
          username: "updateaccountgraphql",
          bio: "Updated profile bio",
          locales: ["ko-KR", "en-US"],
          preferAiSummary: true,
          defaultNoteVisibility: "FOLLOWERS",
          defaultShareVisibility: "UNLISTED",
        },
      },
    });

    const stored = await tx.query.accountTable.findFirst({
      where: { id: account.account.id },
    });
    assert.ok(stored != null);
    assert.equal(stored.hideFromInvitationTree, true);
    assert.equal(stored.hideForeignLanguages, true);
    assert.deepEqual(stored.locales, ["ko-KR", "en-US"]);
    assert.equal(stored.preferAiSummary, true);
    assert.equal(stored.noteVisibility, "followers");
    assert.equal(stored.shareVisibility, "unlisted");
  });
});

test("updateAccount transforms avatarUrl before assigning a medium", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "updateaccountavatarurl",
      name: "Update Account Avatar URL",
      email: "updateaccountavatarurl@example.com",
    });
    const input = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    }).png().toBuffer();
    const avatarUrl = `data:image/png;base64,${input.toString("base64")}`;
    const disk = createTestDisk();
    const fedCtx = createFedCtx(tx);
    fedCtx.data.disk = disk;
    fedCtx.getActor = (identifier: string) =>
      Promise.resolve(
        new vocab.Person({
          id: fedCtx.getActorUri(identifier),
        }),
      );

    const result = await execute({
      schema,
      document: updateAccountMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("Account", account.account.id),
          avatarUrl,
        },
      },
      contextValue: makeUserContext(tx, account.account, { disk, fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const updated = await tx.query.accountTable.findFirst({
      where: { id: account.account.id },
      with: { avatarMedium: true },
    });
    assert.ok(updated?.avatarMedium != null);
    assert.equal(updated.avatarMedium.width, 100);
    assert.equal(updated.avatarMedium.height, 100);
  });
});

test("updateAccount transforms avatarMediumId before assigning it", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "updateaccountavatarid",
      name: "Update Account Avatar ID",
      email: "updateaccountavatarid@example.com",
    });
    const input = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    }).png().toBuffer();
    const disk = createTestDisk();
    const genericMedium = await createMediumFromBytes(tx, disk, input, {
      contentType: "image/png",
    });
    assert.ok(genericMedium != null);
    assert.equal(genericMedium.width, 200);
    assert.equal(genericMedium.height, 100);
    const fedCtx = createFedCtx(tx);
    fedCtx.data.disk = disk;
    fedCtx.getActor = (identifier: string) =>
      Promise.resolve(
        new vocab.Person({
          id: fedCtx.getActorUri(identifier),
        }),
      );

    const result = await execute({
      schema,
      document: updateAccountMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("Account", account.account.id),
          avatarMediumId: genericMedium.id,
        },
      },
      contextValue: makeUserContext(tx, account.account, { disk, fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const updated = await tx.query.accountTable.findFirst({
      where: { id: account.account.id },
      with: { avatarMedium: true },
    });
    assert.ok(updated?.avatarMedium != null);
    assert.notEqual(updated.avatarMedium.id, genericMedium.id);
    assert.equal(updated.avatarMedium.width, 100);
    assert.equal(updated.avatarMedium.height, 100);
  });
});

test("updateAccount rejects a second username change", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "renameonce",
      name: "Rename Once",
      email: "renameonce@example.com",
    });

    const renamed = await updateAccountData(tx, {
      id: account.account.id,
      username: "renamedonce",
    });
    assert.ok(renamed != null);
    assert.ok(renamed.usernameChanged != null);

    const result = await execute({
      schema,
      document: updateAccountMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("Account", account.account.id),
          username: "renamedtwice",
        },
      },
      contextValue: makeUserContext(tx, { ...account.account, ...renamed }),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(toPlainJson(result.data), { updateAccount: null });
    assert.equal(result.errors?.length, 1);
    assert.equal(
      result.errors?.[0].message,
      "Username cannot be changed after it has been changed.",
    );
  });
});
