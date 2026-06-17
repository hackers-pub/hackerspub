import assert from "node:assert";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import * as vocab from "@fedify/vocab";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import sharp from "sharp";
import { updateAccountData } from "@hackerspub/models/account";
import type { Transaction } from "@hackerspub/models/db";
import { createMediumFromBytes } from "@hackerspub/models/medium";
import { createSession, getSession } from "@hackerspub/models/session";
import {
  accountTable,
  actorTable,
  deletedAccountTable,
  flagCaseTable,
  mediumTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import type { UserContext } from "./builder.ts";
import { schema } from "./mod.ts";
import { putProfileOgImage } from "./og.ts";
import {
  createFedCtx,
  createTestDisk,
  createTestKv,
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
      avatarMediumId
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

const accountInviterQuery = parse(`
  query AccountInviter($username: String!) {
    accountByUsername(username: $username) {
      username
      inviter {
        username
      }
    }
  }
`);

const accountInviteesQuery = parse(`
  query AccountInvitees($username: String!, $first: Int!, $after: String) {
    accountByUsername(username: $username) {
      invitees(first: $first, after: $after) {
        totalCount
        edges {
          cursor
          node {
            username
            created
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  }
`);

const accountHideFromTreeQuery = parse(`
  query AccountHideFromTree($username: String!) {
    accountByUsername(username: $username) {
      hideFromInvitationTree
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
        defaultQuotePolicy
      }
    }
  }
`);

const deleteAccountMutation = parse(`
  mutation DeleteAccount($input: DeleteAccountInput!) {
    deleteAccount(input: $input) {
      __typename
      ... on DeleteAccountPayload {
        deletedAccountId
        username
        deleted
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
      ... on NotAuthorizedError {
        notAuthorized
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on AccountDeletionUnavailableError {
        unavailable
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
          avatarMediumId: null,
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

test("invitationTree redacts banned accounts", async () => {
  await withRollback(async (tx) => {
    const banned = await insertAccountWithActor(tx, {
      username: "bannedtree",
      name: "Banned Tree",
      email: "bannedtree@example.com",
    });
    // Permanently suspend (ban) the actor; the account did NOT opt out of the
    // invitation tree, so only the ban should redact it.
    await tx.update(actorTable)
      .set({ suspended: new Date(Date.now() - 1000), suspendedUntil: null })
      .where(eq(actorTable.id, banned.actor.id));

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
    const bannedNode = nodes.find((node) => node.id === banned.account.id);

    assert.ok(bannedNode != null);
    assert.equal(bannedNode.hidden, true);
    assert.equal(bannedNode.username, null);
    assert.equal(bannedNode.name, null);
    assert.equal(
      bannedNode.avatarUrl,
      "https://gravatar.com/avatar/?d=mp&s=128",
    );
  });
});

async function seedInviterAndInvitee(tx: Transaction) {
  const inviter = await insertAccountWithActor(tx, {
    username: "theinviter",
    name: "The Inviter",
    email: "theinviter@example.com",
  });
  const invitee = await insertAccountWithActor(tx, {
    username: "theinvitee",
    name: "The Invitee",
    email: "theinvitee@example.com",
  });
  await updateAccountData(tx, {
    id: invitee.account.id,
    inviterId: inviter.account.id,
  });
  return { inviter, invitee };
}

async function resolveInviterUsername(
  contextValue: UserContext,
): Promise<string | null | undefined> {
  const result = await execute({
    schema,
    document: accountInviterQuery,
    variableValues: { username: "theinvitee" },
    contextValue,
    onError: "NO_PROPAGATE",
  });
  assert.equal(result.errors, undefined);
  const data = result.data as {
    accountByUsername: { inviter: { username: string } | null } | null;
  };
  return data.accountByUsername?.inviter?.username ?? null;
}

test("Account.inviter is visible to guests when neither party is hidden", async () => {
  await withRollback(async (tx) => {
    await seedInviterAndInvitee(tx);
    const username = await resolveInviterUsername(
      makeGuestContext(tx),
    );
    assert.equal(username, "theinviter");
  });
});

test("Account.invitees returns newest invitees first", async () => {
  await withRollback(async (tx) => {
    const inviter = await insertAccountWithActor(tx, {
      username: "sortedinviter",
      name: "Sorted Inviter",
      email: "sortedinviter@example.com",
    });
    const older = await insertAccountWithActor(tx, {
      username: "olderinvitee",
      name: "Older Invitee",
      email: "olderinvitee@example.com",
    });
    const newest = await insertAccountWithActor(tx, {
      username: "newestinvitee",
      name: "Newest Invitee",
      email: "newestinvitee@example.com",
    });
    const middle = await insertAccountWithActor(tx, {
      username: "middleinvitee",
      name: "Middle Invitee",
      email: "middleinvitee@example.com",
    });

    await tx.update(accountTable)
      .set({
        inviterId: inviter.account.id,
        created: new Date("2026-04-15T00:00:01.000Z"),
      })
      .where(eq(accountTable.id, older.account.id));
    await tx.update(accountTable)
      .set({
        inviterId: inviter.account.id,
        created: new Date("2026-04-15T00:00:03.000Z"),
      })
      .where(eq(accountTable.id, newest.account.id));
    await tx.update(accountTable)
      .set({
        inviterId: inviter.account.id,
        created: new Date("2026-04-15T00:00:02.000Z"),
      })
      .where(eq(accountTable.id, middle.account.id));

    const firstPage = await execute({
      schema,
      document: accountInviteesQuery,
      variableValues: { username: inviter.account.username, first: 2 },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(firstPage.errors, undefined);
    const firstPageData = toPlainJson(firstPage.data) as {
      accountByUsername: {
        invitees: {
          totalCount: number;
          edges: Array<{ cursor: string; node: { username: string } }>;
          pageInfo: { hasNextPage: boolean };
        };
      };
    };
    assert.equal(firstPageData.accountByUsername.invitees.totalCount, 3);
    assert.deepEqual(
      firstPageData.accountByUsername.invitees.edges.map((edge) =>
        edge.node.username
      ),
      ["newestinvitee", "middleinvitee"],
    );
    assert.equal(
      firstPageData.accountByUsername.invitees.pageInfo.hasNextPage,
      true,
    );

    const secondPage = await execute({
      schema,
      document: accountInviteesQuery,
      variableValues: {
        username: inviter.account.username,
        first: 2,
        after: firstPageData.accountByUsername.invitees.edges[1].cursor,
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(secondPage.errors, undefined);
    const secondPageData = toPlainJson(secondPage.data) as {
      accountByUsername: {
        invitees: {
          edges: Array<{ node: { username: string } }>;
          pageInfo: { hasNextPage: boolean };
        };
      };
    };
    assert.deepEqual(
      secondPageData.accountByUsername.invitees.edges.map((edge) =>
        edge.node.username
      ),
      ["olderinvitee"],
    );
    assert.equal(
      secondPageData.accountByUsername.invitees.pageInfo.hasNextPage,
      false,
    );
  });
});

test("Account.inviter is hidden from guests when the profile owner opts out", async () => {
  await withRollback(async (tx) => {
    const { invitee } = await seedInviterAndInvitee(tx);
    await updateAccountData(tx, {
      id: invitee.account.id,
      hideFromInvitationTree: true,
    });
    const username = await resolveInviterUsername(
      makeGuestContext(tx),
    );
    assert.equal(username, null);
  });
});

test("Account.inviter is hidden from guests when the inviter opts out", async () => {
  await withRollback(async (tx) => {
    const { inviter } = await seedInviterAndInvitee(tx);
    await updateAccountData(tx, {
      id: inviter.account.id,
      hideFromInvitationTree: true,
    });
    const username = await resolveInviterUsername(
      makeGuestContext(tx),
    );
    assert.equal(username, null);
  });
});

test("Account.inviter ignores the hide setting for the account itself", async () => {
  await withRollback(async (tx) => {
    const { invitee } = await seedInviterAndInvitee(tx);
    await updateAccountData(tx, {
      id: invitee.account.id,
      hideFromInvitationTree: true,
    });
    const username = await resolveInviterUsername(
      makeUserContext(tx, invitee.account),
    );
    assert.equal(username, "theinviter");
  });
});

test("Account.inviter ignores the hide setting for the inviter", async () => {
  await withRollback(async (tx) => {
    const { inviter, invitee } = await seedInviterAndInvitee(tx);
    await updateAccountData(tx, {
      id: invitee.account.id,
      hideFromInvitationTree: true,
    });
    const username = await resolveInviterUsername(
      makeUserContext(tx, inviter.account),
    );
    assert.equal(username, "theinviter");
  });
});

test("Account.inviter ignores the hide setting for moderators", async () => {
  await withRollback(async (tx) => {
    const { invitee } = await seedInviterAndInvitee(tx);
    await updateAccountData(tx, {
      id: invitee.account.id,
      hideFromInvitationTree: true,
    });
    const moderator = await insertAccountWithActor(tx, {
      username: "themoderator",
      name: "The Moderator",
      email: "themoderator@example.com",
    });
    const username = await resolveInviterUsername(
      makeUserContext(tx, { ...moderator.account, moderator: true }),
    );
    assert.equal(username, "theinviter");
  });
});

test("Account.hideFromInvitationTree is readable by the holder but gated for others", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "hidetreeowner",
      name: "Hide Tree Owner",
      email: "hidetreeowner@example.com",
    });
    await updateAccountData(tx, {
      id: account.account.id,
      hideFromInvitationTree: true,
    });

    const ownerResult = await execute({
      schema,
      document: accountHideFromTreeQuery,
      variableValues: { username: "hidetreeowner" },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(ownerResult.errors, undefined);
    assert.deepEqual(toPlainJson(ownerResult.data), {
      accountByUsername: { hideFromInvitationTree: true },
    });

    // A guest is not the account holder or a moderator, so the field is gated.
    const guestResult = await execute({
      schema,
      document: accountHideFromTreeQuery,
      variableValues: { username: "hidetreeowner" },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.notEqual(guestResult.errors, undefined);
    assert.equal(
      (guestResult.data as {
        accountByUsername: { hideFromInvitationTree: boolean | null } | null;
      }).accountByUsername?.hideFromInvitationTree ?? null,
      null,
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
          defaultQuotePolicy: "FOLLOWERS",
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
          // FOLLOWERS visibility normalizes quote policy to SELF
          defaultQuotePolicy: "SELF",
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
    assert.equal(stored.quotePolicy, "self");
  });
});

test("updateAccount updates defaultQuotePolicy", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "updatequotepolicy",
      name: "Update Quote Policy",
      email: "updatequotepolicy@example.com",
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
          defaultQuotePolicy: "SELF",
        },
      },
      contextValue: makeUserContext(tx, account.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      updateAccount: {
        account: {
          username: "updatequotepolicy",
          bio: account.account.bio,
          locales: account.account.locales,
          preferAiSummary: account.account.preferAiSummary,
          defaultNoteVisibility: "PUBLIC",
          defaultShareVisibility: "PUBLIC",
          defaultQuotePolicy: "SELF",
        },
      },
    });

    const stored = await tx.query.accountTable.findFirst({
      where: { id: account.account.id },
    });
    assert.ok(stored != null);
    assert.equal(stored.quotePolicy, "self");
  });
});

test("updateAccount normalizes quotePolicy to self for restricted visibility", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "updatequotepolicynorm",
      name: "Update Quote Policy Normalize",
      email: "updatequotepolicynorm@example.com",
    });

    const fedCtx = createFedCtx(tx);
    fedCtx.getActor = (identifier: string) =>
      Promise.resolve(
        new vocab.Person({
          id: fedCtx.getActorUri(identifier),
        }),
      );

    // Setting FOLLOWERS visibility with EVERYONE quote policy should
    // normalize to SELF at the server.
    const result = await execute({
      schema,
      document: updateAccountMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("Account", account.account.id),
          defaultNoteVisibility: "FOLLOWERS",
          defaultQuotePolicy: "EVERYONE",
        },
      },
      contextValue: makeUserContext(tx, account.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      updateAccount: {
        account: {
          username: "updatequotepolicynorm",
          bio: account.account.bio,
          locales: account.account.locales,
          preferAiSummary: account.account.preferAiSummary,
          defaultNoteVisibility: "FOLLOWERS",
          defaultShareVisibility: "PUBLIC",
          defaultQuotePolicy: "SELF",
        },
      },
    });

    const stored = await tx.query.accountTable.findFirst({
      where: { id: account.account.id },
    });
    assert.ok(stored != null);
    assert.equal(stored.quotePolicy, "self");

    // DIRECT visibility should also normalize to SELF.
    const result2 = await execute({
      schema,
      document: updateAccountMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("Account", account.account.id),
          defaultNoteVisibility: "DIRECT",
          defaultQuotePolicy: "FOLLOWERS",
        },
      },
      contextValue: makeUserContext(tx, account.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result2.errors, undefined);
    assert.deepEqual(
      toPlainJson(result2.data),
      {
        updateAccount: {
          account: {
            username: "updatequotepolicynorm",
            bio: account.account.bio,
            locales: account.account.locales,
            preferAiSummary: account.account.preferAiSummary,
            defaultNoteVisibility: "DIRECT",
            defaultShareVisibility: "PUBLIC",
            defaultQuotePolicy: "SELF",
          },
        },
      },
    );

    // Only updating defaultQuotePolicy while stored visibility remains
    // DIRECT (restricted) should also normalize to SELF.
    const result3 = await execute({
      schema,
      document: updateAccountMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("Account", account.account.id),
          defaultQuotePolicy: "EVERYONE",
        },
      },
      contextValue: makeUserContext(tx, account.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result3.errors, undefined);
    assert.deepEqual(
      toPlainJson(result3.data),
      {
        updateAccount: {
          account: {
            username: "updatequotepolicynorm",
            bio: account.account.bio,
            locales: account.account.locales,
            preferAiSummary: account.account.preferAiSummary,
            defaultNoteVisibility: "DIRECT",
            defaultShareVisibility: "PUBLIC",
            defaultQuotePolicy: "SELF",
          },
        },
      },
    );

    // Updating to PUBLIC visibility should allow setting EVERYONE again.
    const result4 = await execute({
      schema,
      document: updateAccountMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("Account", account.account.id),
          defaultNoteVisibility: "PUBLIC",
          defaultQuotePolicy: "EVERYONE",
        },
      },
      contextValue: makeUserContext(tx, account.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result4.errors, undefined);
    assert.deepEqual(toPlainJson(result4.data), {
      updateAccount: {
        account: {
          username: "updatequotepolicynorm",
          bio: account.account.bio,
          locales: account.account.locales,
          preferAiSummary: account.account.preferAiSummary,
          defaultNoteVisibility: "PUBLIC",
          defaultShareVisibility: "PUBLIC",
          defaultQuotePolicy: "EVERYONE",
        },
      },
    });
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

test("updateAccount rejects usernames reserved by deleted accounts", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "renamefree",
      name: "Rename Free",
      email: "renamefree@example.com",
    });
    await tx.insert(deletedAccountTable).values({
      accountId: generateUuidV7(),
      username: "reservedrename",
      actorIri: "http://localhost/ap/actors/reservedrename",
      deleted: new Date("2026-06-17T00:00:00.000Z"),
    });

    const result = await execute({
      schema,
      document: updateAccountMutation,
      variableValues: {
        input: {
          id: encodeGlobalID("Account", account.account.id),
          username: "reservedrename",
        },
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(toPlainJson(result.data), { updateAccount: null });
    assert.equal(result.errors?.length, 1);
    assert.equal(result.errors?.[0].message, "Username is already taken.");
  });
});

test("deleteAccount deletes the viewer account and session", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const account = await insertAccountWithActor(tx, {
      username: "deletegraphql",
      name: "Delete GraphQL",
      email: "deletegraphql@example.com",
    });
    const session = await createSession(kv, {
      accountId: account.account.id,
      userAgent: "delete-account-test",
    });
    const fedCtx = createFedCtx(tx, { kv });
    const sentActivities: unknown[][] = [];
    fedCtx.sendActivity = ((...args: unknown[]) => {
      sentActivities.push(args);
      return Promise.resolve(undefined);
    }) as typeof fedCtx.sendActivity;

    const result = await execute({
      schema,
      document: deleteAccountMutation,
      variableValues: {
        input: { id: encodeGlobalID("Account", account.account.id) },
      },
      contextValue: makeUserContext(tx, account.account, {
        kv,
        fedCtx,
        session,
      }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const payload = (toPlainJson(result.data) as {
      deleteAccount?: {
        __typename?: string;
        deletedAccountId?: string;
        username?: string;
        deleted?: string;
      };
    }).deleteAccount;
    assert.deepEqual(
      {
        ...payload,
        deleted: typeof payload?.deleted,
      },
      {
        __typename: "DeleteAccountPayload",
        deletedAccountId: encodeGlobalID("Account", account.account.id),
        username: "deletegraphql",
        deleted: "string",
      },
    );
    assert.equal(sentActivities.length, 1);
    assert.equal(await getSession(kv, session.id), undefined);
    assert.equal(
      await tx.query.accountTable.findFirst({
        where: { id: account.account.id },
      }),
      undefined,
    );
    const tombstone = await tx.query.deletedAccountTable.findFirst({
      where: { accountId: account.account.id },
    });
    assert.equal(tombstone?.username, "deletegraphql");
  });
});

test("deleteAccount returns typed errors for invalid callers", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "deleteowner",
      name: "Delete Owner",
      email: "deleteowner@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "deleteother",
      name: "Delete Other",
      email: "deleteother@example.com",
    });
    const missingId = generateUuidV7();

    const guest = await execute({
      schema,
      document: deleteAccountMutation,
      variableValues: {
        input: { id: encodeGlobalID("Account", owner.account.id) },
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(guest.errors, undefined);
    assert.equal(
      (toPlainJson(guest.data) as {
        deleteAccount?: { __typename?: string };
      }).deleteAccount?.__typename,
      "NotAuthenticatedError",
    );

    const foreign = await execute({
      schema,
      document: deleteAccountMutation,
      variableValues: {
        input: { id: encodeGlobalID("Account", other.account.id) },
      },
      contextValue: makeUserContext(tx, owner.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(foreign.errors, undefined);
    assert.equal(
      (toPlainJson(foreign.data) as {
        deleteAccount?: { __typename?: string };
      }).deleteAccount?.__typename,
      "NotAuthorizedError",
    );

    const missing = await execute({
      schema,
      document: deleteAccountMutation,
      variableValues: {
        input: { id: encodeGlobalID("Account", missingId) },
      },
      contextValue: makeUserContext(tx, { ...owner.account, id: missingId }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(missing.errors, undefined);
    assert.deepEqual(toPlainJson(missing.data), {
      deleteAccount: {
        __typename: "InvalidInputError",
        inputPath: "id",
      },
    });
  });
});

test("deleteAccount reports moderation audit blockers generically", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "deleteblocked",
      name: "Delete Blocked",
      email: "deleteblocked@example.com",
    });
    await tx.insert(flagCaseTable).values({
      id: generateUuidV7(),
      targetActorId: account.actor.id,
      status: "pending",
    });

    const result = await execute({
      schema,
      document: deleteAccountMutation,
      variableValues: {
        input: { id: encodeGlobalID("Account", account.account.id) },
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      deleteAccount: {
        __typename: "AccountDeletionUnavailableError",
        unavailable: "",
      },
    });
    assert.ok(
      await tx.query.accountTable.findFirst({
        where: { id: account.account.id },
      }) != null,
    );
  });
});
