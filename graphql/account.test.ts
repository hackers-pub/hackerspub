import assert from "node:assert/strict";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import * as vocab from "@fedify/vocab";
import { execute, parse } from "graphql";
import { updateAccountData } from "@hackerspub/models/account";
import { schema } from "./mod.ts";
import {
  createFedCtx,
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
