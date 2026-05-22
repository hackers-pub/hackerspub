import assert from "node:assert/strict";
import test from "node:test";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  type FedCtxLookupObject,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const searchObjectQuery = parse(`
  query SearchObject($query: String!) {
    searchObject(query: $query) {
      __typename
      ... on SearchedObject {
        url
      }
      ... on EmptySearchQueryError {
        message
      }
    }
  }
`);

test("searchObject returns an error union for empty queries", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: { query: "   " },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: {
        __typename: "EmptySearchQueryError",
        message: "Query cannot be empty",
      },
    });
  });
});

test("searchObject resolves local handles without federation lookup", async () => {
  await withRollback(async (tx) => {
    await insertAccountWithActor(tx, {
      username: "searchhandle",
      name: "Search Handle",
      email: "searchhandle@example.com",
    });

    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: { query: "@searchhandle" },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: {
        __typename: "SearchedObject",
        url: "/@searchhandle",
      },
    });
  });
});

test("searchObject resolves local note URLs to canonical note routes", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "searchnote",
      name: "Search Note",
      email: "searchnote@example.com",
    });
    const { noteSourceId } = await insertNotePost(tx, {
      account: account.account,
      content: "Searchable note",
    });

    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: {
        query: `http://localhost/@${account.account.username}/${noteSourceId}`,
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: {
        __typename: "SearchedObject",
        url: `/@${account.account.username}/${noteSourceId}`,
      },
    });
  });
});

test("searchObject resolves local actor URLs to canonical profile routes", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "searchactorurl",
      name: "Search Actor URL",
      email: "searchactorurl@example.com",
    });

    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: { query: account.actor.iri },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: {
        __typename: "SearchedObject",
        url: `/@${account.account.username}`,
      },
    });
  });
});

test("searchObject resolves cached remote actor URLs without federation lookup", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const recordingLookup: FedCtxLookupObject = (uri) => {
      lookupCalls.push(uri.toString());
      return Promise.resolve(null);
    };
    const fedCtx = createFedCtx(tx, { lookupObject: recordingLookup });

    const remote = await insertRemoteActor(tx, {
      username: "songbirds",
      name: "Songbirds",
      host: "buttersc.one",
      iri: "https://buttersc.one/@songbirds",
    });

    // A same-username local account exists to guard against the regression
    // where URL searches fell through to handle search and resolved to the
    // local actor instead of the remote one.
    await insertAccountWithActor(tx, {
      username: "songbirds",
      name: "Songbirds (local)",
      email: "songbirds-local@example.com",
    });

    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: { query: "https://buttersc.one/@songbirds" },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: {
        __typename: "SearchedObject",
        url: `/${remote.handle}`,
      },
    });
    assert.deepEqual(lookupCalls, []);
  });
});

test("searchObject prefers an actor whose IRI matches a URL query over a colliding url match", async () => {
  await withRollback(async (tx) => {
    const sharedUrl = "https://collide.example/@shared";

    // Actor A: canonical IRI matches the query.
    const canonical = await insertRemoteActor(tx, {
      username: "canonical",
      name: "Canonical",
      host: "canonical.example",
      iri: sharedUrl,
    });

    // Actor B: human-facing `url` collides with A's canonical IRI.  Because
    // `actor.url` is nullable and non-unique, the resolver must prefer the
    // IRI match.
    await insertRemoteActor(tx, {
      username: "collider",
      name: "Collider",
      host: "collide.example",
      url: sharedUrl,
    });

    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: { query: sharedUrl },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: {
        __typename: "SearchedObject",
        url: `/${canonical.handle}`,
      },
    });
  });
});

test("searchObject resolves cached post URLs without federation lookup for signed-in users", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const recordingLookup: FedCtxLookupObject = (uri) => {
      lookupCalls.push(uri.toString());
      return Promise.resolve(null);
    };
    const fedCtx = createFedCtx(tx, { lookupObject: recordingLookup });

    const author = await insertAccountWithActor(tx, {
      username: "cachedposturl",
      name: "Cached Post URL",
      email: "cachedposturl@example.com",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: author.account,
      content: "Cached note for URL search",
    });
    assert.ok(post.url, "test fixture should set post.url");

    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: { query: post.url! },
      contextValue: makeUserContext(tx, author.account, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: {
        __typename: "SearchedObject",
        url: `/@${author.account.username}/${noteSourceId}`,
      },
    });
    assert.deepEqual(lookupCalls, []);
  });
});

test("searchObject does not match a URL path tail against a local handle", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const recordingLookup: FedCtxLookupObject = (uri) => {
      lookupCalls.push(uri.toString());
      return Promise.resolve(null);
    };
    const fedCtx = createFedCtx(tx, { lookupObject: recordingLookup });

    // A same-username local account exists.  A guest search by a remote
    // profile URL whose path ends in `/@uncachedremote` must NOT silently
    // resolve to this local actor (regression guard for the unanchored
    // `HANDLE_REGEXP` bug).
    await insertAccountWithActor(tx, {
      username: "uncachedremote",
      name: "Uncached Remote (local)",
      email: "uncachedremote-local@example.com",
    });

    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: {
        query: "https://uncachedremote.example/@uncachedremote",
      },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: null,
    });
    assert.deepEqual(lookupCalls, []);
  });
});

test("searchObject returns null for an unknown URL without federation lookup", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const recordingLookup: FedCtxLookupObject = (uri) => {
      lookupCalls.push(uri.toString());
      return Promise.resolve(null);
    };
    const fedCtx = createFedCtx(tx, { lookupObject: recordingLookup });

    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: { query: "https://unknown.example/posts/missing" },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: null,
    });
    assert.deepEqual(lookupCalls, []);
  });
});

test("searchObject returns null for an unknown remote handle without federation lookup", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const recordingLookup: FedCtxLookupObject = (uri) => {
      lookupCalls.push(uri.toString());
      return Promise.resolve(null);
    };
    const fedCtx = createFedCtx(tx, { lookupObject: recordingLookup });

    const result = await execute({
      schema,
      document: searchObjectQuery,
      variableValues: { query: "@nobody@unknown.example" },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      searchObject: null,
    });
    assert.deepEqual(lookupCalls, []);
  });
});
