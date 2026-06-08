import assert from "node:assert";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { follow } from "@hackerspub/models/following";
import { sharePost } from "@hackerspub/models/post";
import { actorTable, pinTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  type FedCtxLookupObject,
  insertAccountWithActor,
  insertMention,
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

const actorViewerInteractionsQuery = parse(`
  query ActorViewerInteractions(
    $handle: String!
    $first: Int
    $after: String
    $last: Int
    $before: String
  ) {
    actorByHandle(handle: $handle, allowLocalHandle: true) {
      viewerInteractions(
        first: $first
        after: $after
        last: $last
        before: $before
      ) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        edges {
          cursor
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

test("Actor.viewerInteractions returns direct interactions newest first", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "actorinteractionsviewer",
      name: "Actor Interactions Viewer",
      email: "actorinteractionsviewer@example.com",
    });
    const profile = await insertAccountWithActor(tx, {
      username: "actorinteractionsprofile",
      name: "Actor Interactions Profile",
      email: "actorinteractionsprofile@example.com",
    });
    const thirdParty = await insertAccountWithActor(tx, {
      username: "actorinteractionsthird",
      name: "Actor Interactions Third",
      email: "actorinteractionsthird@example.com",
    });

    const { post: viewerRoot } = await insertNotePost(tx, {
      account: viewer.account,
      content: "Viewer root for GraphQL interactions",
      published: new Date("2026-04-15T00:00:00.000Z"),
    });
    const { post: profileRoot } = await insertNotePost(tx, {
      account: profile.account,
      content: "Profile root for GraphQL interactions",
      published: new Date("2026-04-15T00:00:01.000Z"),
    });
    const { post: viewerMention } = await insertNotePost(tx, {
      account: viewer.account,
      content: "Viewer mentions profile in GraphQL",
      published: new Date("2026-04-15T00:00:02.000Z"),
    });
    await insertMention(tx, {
      postId: viewerMention.id,
      actorId: profile.actor.id,
    });
    const { post: profileReply } = await insertNotePost(tx, {
      account: profile.account,
      content: "Profile replies to viewer in GraphQL",
      replyTargetId: viewerRoot.id,
      published: new Date("2026-04-15T00:00:03.000Z"),
    });
    const { post: profileQuote } = await insertNotePost(tx, {
      account: profile.account,
      content: "Profile quotes viewer in GraphQL",
      quotedPostId: viewerRoot.id,
      published: new Date("2026-04-15T00:00:04.000Z"),
    });
    const { post: profileMention } = await insertNotePost(tx, {
      account: profile.account,
      content: "Profile mentions viewer in GraphQL",
      published: new Date("2026-04-15T00:00:05.000Z"),
    });
    await insertMention(tx, {
      postId: profileMention.id,
      actorId: viewer.actor.id,
    });
    const { post: thirdPartyMention } = await insertNotePost(tx, {
      account: thirdParty.account,
      content: "Third party mentions both in GraphQL",
      published: new Date("2026-04-15T00:00:06.000Z"),
    });
    await insertMention(tx, {
      postId: thirdPartyMention.id,
      actorId: viewer.actor.id,
    });
    await insertMention(tx, {
      postId: thirdPartyMention.id,
      actorId: profile.actor.id,
    });
    await insertNotePost(tx, {
      account: viewer.account,
      content: "Viewer quotes third party",
      quotedPostId: thirdPartyMention.id,
      published: new Date("2026-04-15T00:00:07.000Z"),
    });
    await sharePost(createFedCtx(tx), viewer.account, {
      ...profileRoot,
      actor: profile.actor,
    });

    const result = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: profile.account.username,
        first: 10,
      },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);
    const connection = (toPlainJson(result.data) as {
      actorByHandle: {
        viewerInteractions: {
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
          };
          edges: Array<{ node: { id: string } }>;
        };
      };
    }).actorByHandle.viewerInteractions;
    assert.deepEqual(connection.pageInfo.hasNextPage, false);
    assert.deepEqual(connection.pageInfo.hasPreviousPage, false);
    assert.deepEqual(connection.edges.map((edge) => edge.node.id), [
      encodeGlobalID("Note", profileMention.id),
      encodeGlobalID("Note", profileQuote.id),
      encodeGlobalID("Note", profileReply.id),
      encodeGlobalID("Note", viewerMention.id),
    ]);
  });
});

test("Actor.viewerInteractions requires authentication and is empty for self", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "actorinteractionsauthviewer",
      name: "Actor Interactions Auth Viewer",
      email: "actorinteractionsauthviewer@example.com",
    });
    const profile = await insertAccountWithActor(tx, {
      username: "actorinteractionsauthprofile",
      name: "Actor Interactions Auth Profile",
      email: "actorinteractionsauthprofile@example.com",
    });
    const { post } = await insertNotePost(tx, {
      account: profile.account,
      content: "Auth profile mentions viewer",
      published: new Date("2026-04-15T00:00:01.000Z"),
    });
    await insertMention(tx, {
      postId: post.id,
      actorId: viewer.actor.id,
    });

    const guestResult = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: profile.account.username,
        first: 10,
      },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(
      guestResult.errors?.[0]?.extensions?.code,
      "AUTHENTICATION_REQUIRED",
    );

    const selfResult = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: viewer.account.username,
        first: 10,
      },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(selfResult.errors, undefined);
    assert.deepEqual(toPlainJson(selfResult.data), {
      actorByHandle: {
        viewerInteractions: {
          pageInfo: {
            hasNextPage: false,
            hasPreviousPage: false,
            startCursor: null,
            endCursor: null,
          },
          edges: [],
        },
      },
    });
  });
});

test("Actor.viewerInteractions rejects invalid page windows", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "actorinteractionswindowviewer",
      name: "Actor Interactions Window Viewer",
      email: "actorinteractionswindowviewer@example.com",
    });
    const profile = await insertAccountWithActor(tx, {
      username: "actorinteractionswindowprofile",
      name: "Actor Interactions Window Profile",
      email: "actorinteractionswindowprofile@example.com",
    });

    const result = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: profile.account.username,
        first: 251,
      },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors?.[0]?.extensions?.code, "PAGINATION_ERROR");
    assert.equal(
      result.errors?.[0]?.message,
      "Profile interaction pages are limited to 250 posts.",
    );

    for (
      const variableValues of [
        { handle: profile.account.username, first: -1 },
        { handle: profile.account.username, last: -1 },
      ]
    ) {
      const negativeResult = await execute({
        schema,
        document: actorViewerInteractionsQuery,
        variableValues,
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assert.equal(
        negativeResult.errors?.[0]?.extensions?.code,
        "PAGINATION_ERROR",
      );
      assert.equal(
        negativeResult.errors?.[0]?.message,
        "Pagination limits must be non-negative.",
      );
    }
  });
});

test("Actor.viewerInteractions supports stable cursor pagination", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "actorinteractionspageviewer",
      name: "Actor Interactions Page Viewer",
      email: "actorinteractionspageviewer@example.com",
    });
    const profile = await insertAccountWithActor(tx, {
      username: "actorinteractionspageprofile",
      name: "Actor Interactions Page Profile",
      email: "actorinteractionspageprofile@example.com",
    });
    const timestamp = new Date("2026-04-15T00:00:01.000Z");
    const posts = [];
    for (let i = 0; i < 4; i++) {
      const { post } = await insertNotePost(tx, {
        account: i % 2 === 0 ? viewer.account : profile.account,
        content: `GraphQL interaction page ${i}`,
        published: timestamp,
      });
      await insertMention(tx, {
        postId: post.id,
        actorId: i % 2 === 0 ? profile.actor.id : viewer.actor.id,
      });
      posts.push(post);
    }
    const orderedPosts = [...posts].sort((a, b) => b.id.localeCompare(a.id));

    const firstPage = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: profile.account.username,
        first: 2,
      },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(firstPage.errors, undefined);
    const firstConnection = (toPlainJson(firstPage.data) as {
      actorByHandle: {
        viewerInteractions: {
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
            endCursor: string;
          };
          edges: Array<{ node: { id: string } }>;
        };
      };
    }).actorByHandle.viewerInteractions;
    assert.deepEqual(firstConnection.pageInfo.hasNextPage, true);
    assert.deepEqual(firstConnection.pageInfo.hasPreviousPage, false);
    assert.deepEqual(firstConnection.edges.map((edge) => edge.node.id), [
      encodeGlobalID("Note", orderedPosts[0].id),
      encodeGlobalID("Note", orderedPosts[1].id),
    ]);

    const tailPage = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: profile.account.username,
        last: 2,
      },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(tailPage.errors, undefined);
    const tailConnection = (toPlainJson(tailPage.data) as {
      actorByHandle: {
        viewerInteractions: {
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
          };
          edges: Array<{ node: { id: string } }>;
        };
      };
    }).actorByHandle.viewerInteractions;
    assert.deepEqual(tailConnection.pageInfo.hasNextPage, false);
    assert.deepEqual(tailConnection.pageInfo.hasPreviousPage, true);
    assert.deepEqual(tailConnection.edges.map((edge) => edge.node.id), [
      encodeGlobalID("Note", orderedPosts[2].id),
      encodeGlobalID("Note", orderedPosts[3].id),
    ]);

    const partialBackwardPage = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: profile.account.username,
        last: 2,
        before: firstConnection.pageInfo.endCursor,
      },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(partialBackwardPage.errors, undefined);
    const partialBackwardConnection =
      (toPlainJson(partialBackwardPage.data) as {
        actorByHandle: {
          viewerInteractions: {
            pageInfo: {
              hasNextPage: boolean;
              hasPreviousPage: boolean;
              endCursor: string;
            };
            edges: Array<{ node: { id: string } }>;
          };
        };
      }).actorByHandle.viewerInteractions;
    assert.deepEqual(partialBackwardConnection.pageInfo.hasNextPage, true);
    assert.deepEqual(partialBackwardConnection.pageInfo.hasPreviousPage, false);
    assert.deepEqual(
      partialBackwardConnection.edges.map((edge) => edge.node.id),
      [encodeGlobalID("Note", orderedPosts[0].id)],
    );

    const forwardFromPartialPage = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: profile.account.username,
        first: 2,
        after: partialBackwardConnection.pageInfo.endCursor,
      },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(forwardFromPartialPage.errors, undefined);
    const forwardFromPartialConnection =
      (toPlainJson(forwardFromPartialPage.data) as {
        actorByHandle: {
          viewerInteractions: {
            edges: Array<{ node: { id: string } }>;
          };
        };
      }).actorByHandle.viewerInteractions;
    assert.deepEqual(
      forwardFromPartialConnection.edges.map((edge) => edge.node.id),
      [
        encodeGlobalID("Note", orderedPosts[1].id),
        encodeGlobalID("Note", orderedPosts[2].id),
      ],
    );

    const secondPage = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: profile.account.username,
        first: 2,
        after: firstConnection.pageInfo.endCursor,
      },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(secondPage.errors, undefined);
    const secondConnection = (toPlainJson(secondPage.data) as {
      actorByHandle: {
        viewerInteractions: {
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
            endCursor: string;
          };
          edges: Array<{ node: { id: string } }>;
        };
      };
    }).actorByHandle.viewerInteractions;
    assert.deepEqual(secondConnection.pageInfo.hasNextPage, false);
    assert.deepEqual(secondConnection.pageInfo.hasPreviousPage, true);
    assert.deepEqual(secondConnection.edges.map((edge) => edge.node.id), [
      encodeGlobalID("Note", orderedPosts[2].id),
      encodeGlobalID("Note", orderedPosts[3].id),
    ]);

    const backwardPage = await execute({
      schema,
      document: actorViewerInteractionsQuery,
      variableValues: {
        handle: profile.account.username,
        last: 2,
        before: secondConnection.pageInfo.endCursor,
      },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(backwardPage.errors, undefined);
    const backwardConnection = (toPlainJson(backwardPage.data) as {
      actorByHandle: {
        viewerInteractions: {
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
          };
          edges: Array<{ node: { id: string } }>;
        };
      };
    }).actorByHandle.viewerInteractions;
    assert.deepEqual(backwardConnection.pageInfo.hasNextPage, true);
    assert.deepEqual(backwardConnection.pageInfo.hasPreviousPage, true);
    assert.deepEqual(backwardConnection.edges.map((edge) => edge.node.id), [
      encodeGlobalID("Note", orderedPosts[1].id),
      encodeGlobalID("Note", orderedPosts[2].id),
    ]);
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
