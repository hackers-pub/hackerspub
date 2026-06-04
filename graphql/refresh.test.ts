import assert from "node:assert/strict";
import test from "node:test";
import * as vocab from "@fedify/vocab";
import type { Transaction } from "@hackerspub/models/db";
import { accountTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  type AuthenticatedAccount,
  createFedCtx,
  type FedCtxLookupObject,
  insertAccountWithActor,
  insertRemoteActor,
  insertRemotePost,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

async function makeModerator(
  tx: Transaction,
  values: { username: string; name: string; email: string },
): Promise<AuthenticatedAccount> {
  const { account } = await insertAccountWithActor(tx, values);
  await tx.update(accountTable).set({ moderator: true }).where(
    eq(accountTable.id, account.id),
  );
  return { ...account, moderator: true };
}

const refreshMutation = parse(`
  mutation Refresh($uri: String!) {
    refreshRemoteObject(input: { uri: $uri }) {
      __typename
      ... on RefreshRemoteObjectPayload {
        actor { uuid }
        post { uuid }
      }
      ... on NotAuthenticatedError { notAuthenticated }
      ... on NotAuthorizedError { notAuthorized }
      ... on InvalidInputError { inputPath }
    }
  }
`);

function refreshTypename(data: unknown): string {
  return (data as { refreshRemoteObject: { __typename: string } })
    .refreshRemoteObject.__typename;
}

test("refreshRemoteObject rejects guests with NotAuthenticatedError", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const recordingLookup: FedCtxLookupObject = (uri) => {
      lookupCalls.push(uri.toString());
      return Promise.resolve(null);
    };
    const fedCtx = createFedCtx(tx, { lookupObject: recordingLookup });

    const result = await execute({
      schema,
      document: refreshMutation,
      variableValues: { uri: "https://remote.example/users/whoever" },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(refreshTypename(result.data), "NotAuthenticatedError");
    // Auth is checked before any outbound federation lookup.
    assert.deepEqual(lookupCalls, []);
  });
});

test("refreshRemoteObject rejects non-moderators with NotAuthorizedError", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const recordingLookup: FedCtxLookupObject = (uri) => {
      lookupCalls.push(uri.toString());
      return Promise.resolve(null);
    };
    const fedCtx = createFedCtx(tx, { lookupObject: recordingLookup });
    const { account } = await insertAccountWithActor(tx, {
      username: "refreshplain",
      name: "Refresh Plain",
      email: "refreshplain@example.com",
    });

    const result = await execute({
      schema,
      document: refreshMutation,
      variableValues: { uri: "https://remote.example/users/whoever" },
      contextValue: makeUserContext(tx, account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(refreshTypename(result.data), "NotAuthorizedError");
    assert.deepEqual(lookupCalls, []);
  });
});

test("refreshRemoteObject re-persists a remote actor for a moderator", async () => {
  await withRollback(async (tx) => {
    const moderator = await makeModerator(tx, {
      username: "refreshactormod",
      name: "Refresh Actor Mod",
      email: "refreshactormod@example.com",
    });
    const remote = await insertRemoteActor(tx, {
      username: "staleactor",
      name: "Stale Name",
      host: "remote.example",
      iri: "https://remote.example/users/staleactor",
    });

    const fedCtx = createFedCtx(tx, {
      lookupObject: (uri) => {
        assert.equal(uri.toString(), remote.iri);
        return Promise.resolve(
          new vocab.Person({
            id: new URL(remote.iri),
            preferredUsername: "staleactor",
            name: "Fresh Name",
            inbox: new URL(`${remote.iri}/inbox`),
            endpoints: new vocab.Endpoints({
              sharedInbox: new URL("https://remote.example/inbox"),
            }),
            url: new URL("https://remote.example/@staleactor"),
          }),
        );
      },
    });

    const result = await execute({
      schema,
      document: refreshMutation,
      variableValues: { uri: remote.iri },
      contextValue: makeUserContext(tx, moderator, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const payload = (toPlainJson(result.data) as {
      refreshRemoteObject: {
        __typename: string;
        actor: { uuid: string } | null;
        post: { uuid: string } | null;
      };
    }).refreshRemoteObject;
    assert.equal(payload.__typename, "RefreshRemoteObjectPayload");
    assert.equal(payload.post, null);
    assert.equal(payload.actor?.uuid, remote.id);

    const reloaded = await tx.query.actorTable.findFirst({
      where: { id: remote.id },
    });
    assert.equal(reloaded?.name, "Fresh Name");
  });
});

test("refreshRemoteObject re-persists a remote post for a moderator", async () => {
  await withRollback(async (tx) => {
    const moderator = await makeModerator(tx, {
      username: "refreshpostmod",
      name: "Refresh Post Mod",
      email: "refreshpostmod@example.com",
    });
    const author = await insertRemoteActor(tx, {
      username: "postauthor",
      name: "Post Author",
      host: "remote.example",
      iri: "https://remote.example/users/postauthor",
    });
    const post = await insertRemotePost(tx, {
      actorId: author.id,
      contentHtml: "<p>Old content</p>",
    });

    const fedCtx = createFedCtx(tx, {
      lookupObject: (uri) => {
        assert.equal(uri.toString(), post.iri);
        return Promise.resolve(
          new vocab.Note({
            id: new URL(post.iri),
            attribution: new URL(author.iri),
            to: vocab.PUBLIC_COLLECTION,
            content: "New content",
          }),
        );
      },
    });

    const result = await execute({
      schema,
      document: refreshMutation,
      variableValues: { uri: post.iri },
      contextValue: makeUserContext(tx, moderator, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const payload = (toPlainJson(result.data) as {
      refreshRemoteObject: {
        __typename: string;
        actor: { uuid: string } | null;
        post: { uuid: string } | null;
      };
    }).refreshRemoteObject;
    assert.equal(payload.__typename, "RefreshRemoteObjectPayload");
    assert.equal(payload.actor, null);
    assert.equal(payload.post?.uuid, post.id);

    const reloaded = await tx.query.postTable.findFirst({
      where: { id: post.id },
    });
    assert.ok(reloaded?.contentHtml.includes("New content"));
    assert.ok(!reloaded?.contentHtml.includes("Old content"));
  });
});

test("refreshRemoteObject returns InvalidInputError when the lookup fails", async () => {
  await withRollback(async (tx) => {
    const moderator = await makeModerator(tx, {
      username: "refreshfailmod",
      name: "Refresh Fail Mod",
      email: "refreshfailmod@example.com",
    });
    const fedCtx = createFedCtx(tx, {
      lookupObject: () => Promise.reject(new Error("lookup failed")),
    });

    const result = await execute({
      schema,
      document: refreshMutation,
      variableValues: { uri: "https://remote.example/users/gone" },
      contextValue: makeUserContext(tx, moderator, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(refreshTypename(result.data), "InvalidInputError");
  });
});

test("refreshRemoteObject returns InvalidInputError for non-actor, non-post objects", async () => {
  await withRollback(async (tx) => {
    const moderator = await makeModerator(tx, {
      username: "refreshothermod",
      name: "Refresh Other Mod",
      email: "refreshothermod@example.com",
    });
    const fedCtx = createFedCtx(tx, {
      lookupObject: () =>
        Promise.resolve(
          new vocab.Collection({
            id: new URL("https://remote.example/collections/featured"),
          }),
        ),
    });

    const result = await execute({
      schema,
      document: refreshMutation,
      variableValues: {
        uri: "https://remote.example/collections/featured",
      },
      contextValue: makeUserContext(tx, moderator, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(refreshTypename(result.data), "InvalidInputError");
  });
});

test("refreshRemoteObject refuses to refresh a local object", async () => {
  await withRollback(async (tx) => {
    const moderator = await makeModerator(tx, {
      username: "refreshlocalmod",
      name: "Refresh Local Mod",
      email: "refreshlocalmod@example.com",
    });
    const local = await insertAccountWithActor(tx, {
      username: "refreshlocaltarget",
      name: "Refresh Local Target",
      email: "refreshlocaltarget@example.com",
    });

    const fedCtx = createFedCtx(tx, {
      lookupObject: (uri) => {
        assert.equal(uri.toString(), local.actor.iri);
        return Promise.resolve(
          new vocab.Person({
            id: new URL(local.actor.iri),
            preferredUsername: local.account.username,
            inbox: new URL(`${local.actor.iri}/inbox`),
          }),
        );
      },
    });

    const result = await execute({
      schema,
      document: refreshMutation,
      variableValues: { uri: local.actor.iri },
      contextValue: makeUserContext(tx, moderator, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.equal(refreshTypename(result.data), "InvalidInputError");
  });
});
