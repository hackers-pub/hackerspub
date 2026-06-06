import assert from "node:assert";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { follow } from "@hackerspub/models/following";
import { actorTable, pinTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  type FedCtxLookupObject,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const actorByUuidQuery = parse(`
  query ActorByUuid($uuid: UUID!) {
    actorByUuid(uuid: $uuid) {
      id
      handle
    }
  }
`);

const actorByHandleQuery = parse(`
  query ActorByHandle($handle: String!, $allowLocalHandle: Boolean!) {
    actorByHandle(handle: $handle, allowLocalHandle: $allowLocalHandle) {
      id
      handle
    }
  }
`);

const actorByUrlQuery = parse(`
  query ActorByUrl($url: URL!) {
    actorByUrl(url: $url) {
      id
      handle
    }
  }
`);

const actorPinsQuery = parse(`
  query ActorPins($handle: String!) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      pins(first: 10) {
        edges {
          node {
            id
          }
        }
      }
    }
  }
`);

const instanceByHostQuery = parse(`
  query InstanceByHost($host: String!) {
    instanceByHost(host: $host) {
      host
      software
    }
  }
`);

const searchActorsByHandleQuery = parse(`
  query SearchActorsByHandle($prefix: String!, $limit: Int!) {
    searchActorsByHandle(prefix: $prefix, limit: $limit) {
      handle
    }
  }
`);

const recommendedActorsQuery = parse(`
  query RecommendedActors($limit: Int!, $locale: Locale) {
    recommendedActors(limit: $limit, locale: $locale) {
      handle
    }
  }
`);

test("actorByUuid and actorByHandle resolve local actors", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "actorlookupgraphql",
      name: "Actor Lookup GraphQL",
      email: "actorlookupgraphql@example.com",
    });

    const byUuid = await execute({
      schema,
      document: actorByUuidQuery,
      variableValues: { uuid: actor.actor.id },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(byUuid.errors, undefined);
    assert.deepEqual(toPlainJson(byUuid.data), {
      actorByUuid: {
        id: encodeGlobalID("Actor", actor.actor.id),
        handle: "@actorlookupgraphql@localhost",
      },
    });

    const byHandle = await execute({
      schema,
      document: actorByHandleQuery,
      variableValues: {
        handle: actor.account.username,
        allowLocalHandle: true,
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(byHandle.errors, undefined);
    assert.deepEqual(toPlainJson(byHandle.data), {
      actorByHandle: {
        id: encodeGlobalID("Actor", actor.actor.id),
        handle: "@actorlookupgraphql@localhost",
      },
    });
  });
});

test("actorByUrl resolves a local actor by IRI", async () => {
  await withRollback(async (tx) => {
    const actor = await insertAccountWithActor(tx, {
      username: "actorbyurllocal",
      name: "Actor By URL Local",
      email: "actorbyurllocal@example.com",
    });

    const result = await execute({
      schema,
      document: actorByUrlQuery,
      variableValues: { url: actor.actor.iri },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByUrl: {
        id: encodeGlobalID("Actor", actor.actor.id),
        handle: "@actorbyurllocal@localhost",
      },
    });
  });
});

test("actorByUrl resolves a remote actor by IRI", async () => {
  await withRollback(async (tx) => {
    const remote = await insertRemoteActor(tx, {
      username: "actorbyurlremote",
      name: "Actor By URL Remote",
      host: "remote.example",
    });

    const result = await execute({
      schema,
      document: actorByUrlQuery,
      variableValues: { url: remote.iri },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByUrl: {
        id: encodeGlobalID("Actor", remote.id),
        handle: "@actorbyurlremote@remote.example",
      },
    });
  });
});

test("actorByUrl resolves a remote actor by its human-facing url", async () => {
  await withRollback(async (tx) => {
    const remote = await insertRemoteActor(tx, {
      username: "actorbyurlhuman",
      name: "Actor By URL Human",
      host: "remote.example",
    });
    const profileUrl = `https://remote.example/@actorbyurlhuman`;
    await tx.update(actorTable).set({ url: profileUrl }).where(
      eq(actorTable.id, remote.id),
    );

    const result = await execute({
      schema,
      document: actorByUrlQuery,
      variableValues: { url: profileUrl },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByUrl: {
        id: encodeGlobalID("Actor", remote.id),
        handle: "@actorbyurlhuman@remote.example",
      },
    });
  });
});

test("actorByUrl prefers an IRI match over a colliding url match", async () => {
  await withRollback(async (tx) => {
    const intended = await insertRemoteActor(tx, {
      username: "actorbyurliri",
      name: "Actor By URL IRI",
      host: "iri.example",
      iri: "https://iri.example/users/intended",
    });
    const collider = await insertRemoteActor(tx, {
      username: "actorbyurlcollider",
      name: "Actor By URL Collider",
      host: "collider.example",
    });
    // The collider's `url` is set to the intended actor's IRI. A query for
    // that string must return the actor whose `iri` matches, not the actor
    // whose `url` matches.
    await tx.update(actorTable).set({ url: intended.iri }).where(
      eq(actorTable.id, collider.id),
    );

    const result = await execute({
      schema,
      document: actorByUrlQuery,
      variableValues: { url: intended.iri },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByUrl: {
        id: encodeGlobalID("Actor", intended.id),
        handle: "@actorbyurliri@iri.example",
      },
    });
  });
});

test("actorByUrl returns null for an unknown URL without federation lookup", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const recordingLookup: FedCtxLookupObject = (uri) => {
      lookupCalls.push(uri.toString());
      return Promise.resolve(null);
    };
    const fedCtx = createFedCtx(tx, { lookupObject: recordingLookup });
    const result = await execute({
      schema,
      document: actorByUrlQuery,
      variableValues: { url: "https://example.invalid/users/nobody" },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByUrl: null,
    });
    assert.deepEqual(lookupCalls, []);
  });
});

test("actorByHandle returns null for an unknown remote handle without federation lookup", async () => {
  await withRollback(async (tx) => {
    const lookupCalls: string[] = [];
    const recordingLookup: FedCtxLookupObject = (uri) => {
      lookupCalls.push(uri.toString());
      return Promise.resolve(null);
    };
    const fedCtx = createFedCtx(tx, { lookupObject: recordingLookup });
    const result = await execute({
      schema,
      document: actorByHandleQuery,
      variableValues: {
        handle: "@nobody@unknown.example",
        allowLocalHandle: false,
      },
      contextValue: makeGuestContext(tx, { fedCtx }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByHandle: null,
    });
    assert.deepEqual(lookupCalls, []);
  });
});

test("actor pins hide posts that are not visible to the viewer", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "actorpinsauthor",
      name: "Actor Pins Author",
      email: "actorpinsauthor@example.com",
    });
    const viewer = await insertAccountWithActor(tx, {
      username: "actorpinsviewer",
      name: "Actor Pins Viewer",
      email: "actorpinsviewer@example.com",
    });
    const { post: publicPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Visible pinned post",
    });
    const { post: hiddenPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Hidden pinned post",
      visibility: "followers",
    });
    await tx.insert(pinTable).values([
      { actorId: author.actor.id, postId: publicPost.id },
      { actorId: author.actor.id, postId: hiddenPost.id },
    ]);

    const result = await execute({
      schema,
      document: actorPinsQuery,
      variableValues: { handle: author.account.username },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByHandle: {
        pins: {
          edges: [
            {
              node: {
                id: encodeGlobalID("Note", publicPost.id),
              },
            },
          ],
        },
      },
    });
  });
});

test("actor pins are ordered by newest pin first", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "actorpinorder",
      name: "Actor Pin Order",
      email: "actorpinorder@example.com",
    });
    const { post: olderPinnedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Older pin",
    });
    const { post: newerPinnedPost } = await insertNotePost(tx, {
      account: author.account,
      content: "Newer pin",
    });
    await tx.insert(pinTable).values([
      {
        actorId: author.actor.id,
        postId: olderPinnedPost.id,
        created: new Date("2026-04-15T00:00:00.000Z"),
      },
      {
        actorId: author.actor.id,
        postId: newerPinnedPost.id,
        created: new Date("2026-04-16T00:00:00.000Z"),
      },
    ]);

    const result = await execute({
      schema,
      document: actorPinsQuery,
      variableValues: { handle: author.account.username },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      actorByHandle: {
        pins: {
          edges: [
            {
              node: {
                id: encodeGlobalID("Note", newerPinnedPost.id),
              },
            },
            {
              node: {
                id: encodeGlobalID("Note", olderPinnedPost.id),
              },
            },
          ],
        },
      },
    });
  });
});

test("instanceByHost and searchActorsByHandle expose lookup results", async () => {
  await withRollback(async (tx) => {
    const local = await insertAccountWithActor(tx, {
      username: "actorsearchlocal",
      name: "Actor Search Local",
      email: "actorsearchlocal@example.com",
    });
    const remote = await insertRemoteActor(tx, {
      username: "actorsearchremote",
      name: "Actor Search Remote",
      host: "remote.example",
    });

    const instance = await execute({
      schema,
      document: instanceByHostQuery,
      variableValues: { host: "remote.example" },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(instance.errors, undefined);
    assert.deepEqual(toPlainJson(instance.data), {
      instanceByHost: {
        host: "remote.example",
        software: "hackerspub",
      },
    });

    const search = await execute({
      schema,
      document: searchActorsByHandleQuery,
      variableValues: { prefix: "actorsearch", limit: 10 },
      contextValue: makeUserContext(tx, local.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(search.errors, undefined);
    const handles = (toPlainJson(search.data) as {
      searchActorsByHandle: Array<{ handle: string }>;
    }).searchActorsByHandle.map((actor) => actor.handle);

    assert.ok(handles.includes("@actorsearchlocal@localhost"));
    assert.ok(handles.includes(`@${remote.username}@${remote.handleHost}`));
  });
});

test("recommendedActors excludes followed actors and filters by locale", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "actorrecommendviewer",
      name: "Actor Recommend Viewer",
      email: "actorrecommendviewer@example.com",
    });
    const localCandidate = await insertAccountWithActor(tx, {
      username: "actorrecommendlocal",
      name: "Actor Recommend Local",
      email: "actorrecommendlocal@example.com",
    });
    const followedCandidate = await insertAccountWithActor(tx, {
      username: "actorrecommendfollowed",
      name: "Actor Recommend Followed",
      email: "actorrecommendfollowed@example.com",
    });
    const remoteCandidate = await insertRemoteActor(tx, {
      username: "actorrecommendremote",
      name: "Actor Recommend Remote",
      host: "remote.example",
    });
    await insertNotePost(tx, {
      account: localCandidate.account,
      language: "en",
      content: "Recommended local post",
    });
    await insertNotePost(tx, {
      account: followedCandidate.account,
      language: "en",
      content: "Recommended followed post",
    });
    await insertRemotePost(tx, {
      actorId: remoteCandidate.id,
      language: "ja",
      contentHtml: "<p>Japanese remote post</p>",
    });

    const fedCtx = createFedCtx(tx);
    await follow(fedCtx, viewer.account, followedCandidate.actor);

    const result = await execute({
      schema,
      document: recommendedActorsQuery,
      variableValues: { limit: 10, locale: "en-US" },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const handles = (toPlainJson(result.data) as {
      recommendedActors: Array<{ handle: string }>;
    }).recommendedActors.map((actor) => actor.handle);

    assert.ok(handles.includes("@actorrecommendlocal@localhost"));
    assert.ok(!handles.includes("@actorrecommendfollowed@localhost"));
    assert.ok(!handles.includes("@actorrecommendremote@remote.example"));
  });
});
