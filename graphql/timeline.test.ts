import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { and, eq } from "drizzle-orm";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { createBookmark } from "@hackerspub/models/bookmark";
import { follow } from "@hackerspub/models/following";
import { sharePost } from "@hackerspub/models/post";
import { addPostToTimeline } from "@hackerspub/models/timeline";
import {
  bookmarkTable,
  postTable,
  timelineItemTable,
} from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  insertRemotePost,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const publicTimelineQuery = parse(`
  query PublicTimelineTest(
    $first: Int
    $after: String
    $last: Int
    $before: String
    $local: Boolean
    $withoutShares: Boolean
  ) {
    publicTimeline(
      first: $first
      after: $after
      last: $last
      before: $before
      local: $local
      withoutShares: $withoutShares
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
`);

const personalTimelineQuery = parse(`
  query PersonalTimelineTest(
    $first: Int
    $after: String
    $last: Int
    $before: String
    $withoutShares: Boolean
  ) {
    personalTimeline(
      first: $first
      after: $after
      last: $last
      before: $before
      withoutShares: $withoutShares
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
        lastSharer {
          id
        }
        sharersCount
      }
    }
  }
`);

const bookmarksQuery = parse(`
  query BookmarksTest(
    $first: Int
    $after: String
    $last: Int
    $before: String
  ) {
    bookmarks(first: $first, after: $after, last: $last, before: $before) {
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
`);

Deno.test({
  name: "publicTimeline rejects pages over the maximum window",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const result = await execute({
        schema,
        document: publicTimelineQuery,
        variableValues: { first: 251 },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });

      assertEquals(
        (result.data as { publicTimeline: unknown }).publicTimeline,
        null,
      );
      assertEquals(
        result.errors?.[0].message,
        "Timeline pages are limited to 250 posts.",
      );
      assertEquals(result.errors?.[0].extensions?.code, "PAGINATION_ERROR");
    });
  },
});

Deno.test({
  name: "publicTimeline exposes forward pagination metadata",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const localAuthor = await insertAccountWithActor(tx, {
        username: "graphqltimelineauthor",
        name: "GraphQL Timeline Author",
        email: "graphqltimelineauthor@example.com",
      });
      const { post: localPost } = await insertNotePost(tx, {
        account: localAuthor.account,
        content: "Local timeline post",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: "graphqltimeremote",
        name: "GraphQL Timeline Remote",
        host: "graphql.timeline.example",
      });
      const remotePost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Remote timeline post</p>",
      });

      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:01.000Z"),
          updated: new Date("2026-04-15T00:00:01.000Z"),
        })
        .where(eq(postTable.id, localPost.id));
      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:02.000Z"),
          updated: new Date("2026-04-15T00:00:02.000Z"),
        })
        .where(eq(postTable.id, remotePost.id));

      const result = await execute({
        schema,
        document: publicTimelineQuery,
        variableValues: { first: 1 },
        contextValue: makeUserContext(tx, localAuthor.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const connection = (result.data as {
        publicTimeline: {
          pageInfo: { hasNextPage: boolean };
          edges: { node: { id: string } }[];
        };
      }).publicTimeline;

      assertEquals(connection.pageInfo.hasNextPage, true);
      assertEquals(connection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", remotePost.id),
      ]);
    });
  },
});

Deno.test({
  name: "publicTimeline supports forward and backward cursor pagination",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "graphqlpublicpaginationauthor",
        name: "GraphQL Public Pagination Author",
        email: "graphqlpublicpaginationauthor@example.com",
      });
      const posts = [];
      const timestamp = new Date("2026-04-15T00:00:01.000Z");
      for (let i = 1; i <= 4; i++) {
        const { post } = await insertNotePost(tx, {
          account: author.account,
          content: `Public pagination post ${i}`,
          published: timestamp,
        });
        posts.push(post);
      }
      const orderedPosts = [...posts].sort((a, b) => b.id.localeCompare(a.id));

      const firstPage = await execute({
        schema,
        document: publicTimelineQuery,
        variableValues: { first: 2 },
        contextValue: makeUserContext(tx, author.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(firstPage.errors, undefined);
      const firstConnection = (firstPage.data as {
        publicTimeline: {
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
            endCursor: string;
          };
          edges: { cursor: string; node: { id: string } }[];
        };
      }).publicTimeline;
      assertEquals(firstConnection.pageInfo.hasNextPage, true);
      assertEquals(firstConnection.pageInfo.hasPreviousPage, false);
      assertEquals(firstConnection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", orderedPosts[0].id),
        encodeGlobalID("Note", orderedPosts[1].id),
      ]);

      const secondPage = await execute({
        schema,
        document: publicTimelineQuery,
        variableValues: {
          first: 2,
          after: firstConnection.pageInfo.endCursor,
        },
        contextValue: makeUserContext(tx, author.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(secondPage.errors, undefined);
      const secondConnection = (secondPage.data as {
        publicTimeline: {
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
            endCursor: string;
          };
          edges: { cursor: string; node: { id: string } }[];
        };
      }).publicTimeline;
      assertEquals(secondConnection.pageInfo.hasNextPage, false);
      assertEquals(secondConnection.pageInfo.hasPreviousPage, true);
      assertEquals(secondConnection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", orderedPosts[2].id),
        encodeGlobalID("Note", orderedPosts[3].id),
      ]);

      const backwardPage = await execute({
        schema,
        document: publicTimelineQuery,
        variableValues: {
          last: 2,
          before: secondConnection.pageInfo.endCursor,
        },
        contextValue: makeUserContext(tx, author.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(backwardPage.errors, undefined);
      const backwardConnection = (backwardPage.data as {
        publicTimeline: {
          pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
          edges: { node: { id: string } }[];
        };
      }).publicTimeline;
      assertEquals(backwardConnection.pageInfo.hasNextPage, true);
      assertEquals(backwardConnection.pageInfo.hasPreviousPage, true);
      assertEquals(backwardConnection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", orderedPosts[1].id),
        encodeGlobalID("Note", orderedPosts[2].id),
      ]);
    });
  },
});

Deno.test({
  name: "publicTimeline and personalTimeline honor share filters",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const localAuthor = await insertAccountWithActor(tx, {
        username: "graphqllocalfilterauthor",
        name: "GraphQL Local Filter Author",
        email: "graphqllocalfilterauthor@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "graphqltimelinefiltersharer",
        name: "GraphQL Timeline Filter Sharer",
        email: "graphqltimelinefiltersharer@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "graphqltimelinefilterviewer",
        name: "GraphQL Timeline Filter Viewer",
        email: "graphqltimelinefilterviewer@example.com",
      });
      const { post: localPost } = await insertNotePost(tx, {
        account: localAuthor.account,
        content: "Filtered local post",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: "graphqltimelinefilterremote",
        name: "GraphQL Timeline Filter Remote",
        host: "timeline-filter.example",
      });
      const remotePost = await insertRemotePost(tx, {
        actorId: remoteActor.id,
        contentHtml: "<p>Filtered remote post</p>",
      });

      await follow(fedCtx, viewer.account, sharer.actor);
      const share = await sharePost(fedCtx, sharer.account, {
        ...remotePost,
        actor: remoteActor,
      });

      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:01.000Z"),
          updated: new Date("2026-04-15T00:00:01.000Z"),
        })
        .where(eq(postTable.id, localPost.id));
      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:02.000Z"),
          updated: new Date("2026-04-15T00:00:02.000Z"),
        })
        .where(eq(postTable.id, remotePost.id));
      await tx.update(postTable)
        .set({
          published: new Date("2026-04-15T00:00:03.000Z"),
          updated: new Date("2026-04-15T00:00:03.000Z"),
        })
        .where(eq(postTable.id, share.id));

      const publicResult = await execute({
        schema,
        document: publicTimelineQuery,
        variableValues: {
          first: 10,
          local: true,
          withoutShares: true,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(publicResult.errors, undefined);
      assertEquals(
        (publicResult.data as {
          publicTimeline: { edges: { node: { id: string } }[] };
        }).publicTimeline.edges.map((edge) => edge.node.id),
        [encodeGlobalID("Note", localPost.id)],
      );

      const personalResult = await execute({
        schema,
        document: personalTimelineQuery,
        variableValues: { withoutShares: false },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(personalResult.errors, undefined);

      const personalEdges = (personalResult.data as {
        personalTimeline: {
          edges: {
            node: { id: string };
            lastSharer: { id: string } | null;
            sharersCount: number;
          }[];
        };
      }).personalTimeline.edges;
      assertEquals(personalEdges.length, 1);
      assertEquals(
        personalEdges[0].node.id,
        encodeGlobalID("Note", remotePost.id),
      );
      assertEquals(
        personalEdges[0].lastSharer?.id,
        encodeGlobalID("Actor", sharer.actor.id),
      );
      assertEquals(personalEdges[0].sharersCount, 1);

      const withoutSharesResult = await execute({
        schema,
        document: personalTimelineQuery,
        variableValues: { withoutShares: true },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(withoutSharesResult.errors, undefined);
      assertEquals(
        (withoutSharesResult.data as {
          personalTimeline: { edges: unknown[] };
        }).personalTimeline.edges,
        [],
      );
    });
  },
});

Deno.test({
  name: "personalTimeline rejects pages over the maximum window",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const viewer = await insertAccountWithActor(tx, {
        username: "graphqlpersonalmaxwindowviewer",
        name: "GraphQL Personal Max Window Viewer",
        email: "graphqlpersonalmaxwindowviewer@example.com",
      });

      const result = await execute({
        schema,
        document: personalTimelineQuery,
        variableValues: { last: 251 },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(
        (result.data as { personalTimeline: unknown }).personalTimeline,
        null,
      );
      assertEquals(
        result.errors?.[0].message,
        "Timeline pages are limited to 250 posts.",
      );
      assertEquals(result.errors?.[0].extensions?.code, "PAGINATION_ERROR");
    });
  },
});

Deno.test({
  name: "personalTimeline supports forward and backward cursor pagination",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const viewer = await insertAccountWithActor(tx, {
        username: "graphqlpersonalpaginationviewer",
        name: "GraphQL Personal Pagination Viewer",
        email: "graphqlpersonalpaginationviewer@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "graphqlpersonalpaginationsharer",
        name: "GraphQL Personal Pagination Sharer",
        email: "graphqlpersonalpaginationsharer@example.com",
      });
      const remoteActor = await insertRemoteActor(tx, {
        username: "graphqlpersonalpaginationremote",
        name: "GraphQL Personal Pagination Remote",
        host: "personal-pagination.example",
      });

      await follow(fedCtx, viewer.account, sharer.actor);

      const posts = [];
      const timestamp = new Date("2026-04-15T00:01:00.000Z");
      for (let i = 1; i <= 4; i++) {
        const remotePost = await insertRemotePost(tx, {
          actorId: remoteActor.id,
          contentHtml: `<p>Personal pagination post ${i}</p>`,
          published: timestamp,
        });
        const share = await sharePost(fedCtx, sharer.account, {
          ...remotePost,
          actor: remoteActor,
        });
        await tx.update(postTable)
          .set({ published: timestamp, updated: timestamp })
          .where(eq(postTable.id, share.id));
        await tx.update(timelineItemTable)
          .set({ appended: timestamp })
          .where(
            and(
              eq(timelineItemTable.accountId, viewer.account.id),
              eq(timelineItemTable.postId, remotePost.id),
            ),
          );
        posts.push(remotePost);
      }
      const orderedPosts = [...posts].sort((a, b) => b.id.localeCompare(a.id));

      const firstPage = await execute({
        schema,
        document: personalTimelineQuery,
        variableValues: { first: 2 },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(firstPage.errors, undefined);
      const firstConnection = (firstPage.data as {
        personalTimeline: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: { node: { id: string } }[];
        };
      }).personalTimeline;
      assertEquals(firstConnection.pageInfo.hasNextPage, true);
      assertEquals(firstConnection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", orderedPosts[0].id),
        encodeGlobalID("Note", orderedPosts[1].id),
      ]);

      const secondPage = await execute({
        schema,
        document: personalTimelineQuery,
        variableValues: {
          first: 2,
          after: firstConnection.pageInfo.endCursor,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(secondPage.errors, undefined);
      const secondConnection = (secondPage.data as {
        personalTimeline: {
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
            endCursor: string;
          };
          edges: { node: { id: string } }[];
        };
      }).personalTimeline;
      assertEquals(secondConnection.pageInfo.hasNextPage, false);
      assertEquals(secondConnection.pageInfo.hasPreviousPage, true);
      assertEquals(secondConnection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", orderedPosts[2].id),
        encodeGlobalID("Note", orderedPosts[3].id),
      ]);

      const backwardPage = await execute({
        schema,
        document: personalTimelineQuery,
        variableValues: {
          last: 2,
          before: secondConnection.pageInfo.endCursor,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(backwardPage.errors, undefined);
      const backwardConnection = (backwardPage.data as {
        personalTimeline: {
          pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
          edges: { node: { id: string } }[];
        };
      }).personalTimeline;
      assertEquals(backwardConnection.pageInfo.hasNextPage, true);
      assertEquals(backwardConnection.pageInfo.hasPreviousPage, true);
      assertEquals(backwardConnection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", orderedPosts[1].id),
        encodeGlobalID("Note", orderedPosts[2].id),
      ]);
    });
  },
});

Deno.test({
  name: "bookmarks supports forward and backward cursor pagination",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const viewer = await insertAccountWithActor(tx, {
        username: "graphqlbookmarkpaginationviewer",
        name: "GraphQL Bookmark Pagination Viewer",
        email: "graphqlbookmarkpaginationviewer@example.com",
      });
      const author = await insertAccountWithActor(tx, {
        username: "graphqlbookmarkpaginationauthor",
        name: "GraphQL Bookmark Pagination Author",
        email: "graphqlbookmarkpaginationauthor@example.com",
      });

      const posts = [];
      for (let i = 1; i <= 4; i++) {
        const { post } = await insertNotePost(tx, {
          account: author.account,
          content: `Bookmark pagination post ${i}`,
          published: new Date(`2026-04-15T00:00:0${i}.000Z`),
        });
        await createBookmark(tx, viewer.account, post);
        await tx.update(bookmarkTable)
          .set({ created: new Date(`2026-04-15T00:02:0${i}.000Z`) })
          .where(
            and(
              eq(bookmarkTable.accountId, viewer.account.id),
              eq(bookmarkTable.postId, post.id),
            ),
          );
        posts.push(post);
      }

      const firstPage = await execute({
        schema,
        document: bookmarksQuery,
        variableValues: { first: 2 },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(firstPage.errors, undefined);
      const firstConnection = (firstPage.data as {
        bookmarks: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          edges: { node: { id: string } }[];
        };
      }).bookmarks;
      assertEquals(firstConnection.pageInfo.hasNextPage, true);
      assertEquals(firstConnection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", posts[3].id),
        encodeGlobalID("Note", posts[2].id),
      ]);

      const secondPage = await execute({
        schema,
        document: bookmarksQuery,
        variableValues: {
          first: 2,
          after: firstConnection.pageInfo.endCursor,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(secondPage.errors, undefined);
      const secondConnection = (secondPage.data as {
        bookmarks: {
          pageInfo: {
            hasNextPage: boolean;
            hasPreviousPage: boolean;
            endCursor: string;
          };
          edges: { node: { id: string } }[];
        };
      }).bookmarks;
      assertEquals(secondConnection.pageInfo.hasNextPage, false);
      assertEquals(secondConnection.pageInfo.hasPreviousPage, true);
      assertEquals(secondConnection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", posts[1].id),
        encodeGlobalID("Note", posts[0].id),
      ]);

      const backwardPage = await execute({
        schema,
        document: bookmarksQuery,
        variableValues: {
          last: 2,
          before: secondConnection.pageInfo.endCursor,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(backwardPage.errors, undefined);
      const backwardConnection = (backwardPage.data as {
        bookmarks: {
          pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
          edges: { node: { id: string } }[];
        };
      }).bookmarks;
      assertEquals(backwardConnection.pageInfo.hasNextPage, true);
      assertEquals(backwardConnection.pageInfo.hasPreviousPage, true);
      assertEquals(backwardConnection.edges.map((edge) => edge.node.id), [
        encodeGlobalID("Note", posts[2].id),
        encodeGlobalID("Note", posts[1].id),
      ]);
    });
  },
});

const personalTimelineLanguageQuery = parse(`
  query PersonalTimelineLanguageTest($languages: [Locale!]) {
    personalTimeline(first: 10, languages: $languages) {
      edges {
        node {
          id
        }
      }
    }
  }
`);

Deno.test({
  name:
    "personalTimeline() filters posts by base language code via languages arg",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const viewer = await insertAccountWithActor(tx, {
        username: "personallangfilterviewer",
        name: "Personal Lang Filter Viewer",
        email: "personallangfilterviewer@example.com",
      });
      const author = await insertAccountWithActor(tx, {
        username: "personallangfilterauthor",
        name: "Personal Lang Filter Author",
        email: "personallangfilterauthor@example.com",
      });

      await follow(fedCtx, viewer.account, author.actor);

      const ts = new Date("2026-04-15T14:00:00.000Z");
      const { post: enPost } = await insertNotePost(tx, {
        account: author.account,
        content: "English post",
        language: "en",
        published: new Date(ts.getTime() + 2000),
      });
      await addPostToTimeline(tx, enPost);
      const { post: enGbPost } = await insertNotePost(tx, {
        account: author.account,
        content: "English GB post",
        language: "en-GB",
        published: new Date(ts.getTime() + 1000),
      });
      await addPostToTimeline(tx, enGbPost);
      const { post: jaPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Japanese post",
        language: "ja",
        published: ts,
      });
      await addPostToTimeline(tx, jaPost);

      const ctx = makeUserContext(tx, viewer.account);

      const enOnly = await execute({
        schema,
        document: personalTimelineLanguageQuery,
        contextValue: ctx,
        variableValues: { languages: ["en"] },
      });
      assertEquals(enOnly.errors, undefined);
      type TimelineData = {
        personalTimeline: { edges: { node: { id: string } }[] };
      };
      assertEquals(
        (enOnly.data as TimelineData).personalTimeline.edges.map((e) =>
          e.node.id
        ),
        [
          encodeGlobalID("Note", enPost.id),
          encodeGlobalID("Note", enGbPost.id),
        ],
        "'en' matches 'en' and 'en-GB'",
      );

      const jaOnly = await execute({
        schema,
        document: personalTimelineLanguageQuery,
        contextValue: ctx,
        variableValues: { languages: ["ja"] },
      });
      assertEquals(jaOnly.errors, undefined);
      assertEquals(
        (jaOnly.data as TimelineData).personalTimeline.edges.map((e) =>
          e.node.id
        ),
        [encodeGlobalID("Note", jaPost.id)],
        "'ja' matches only 'ja'",
      );

      const all = await execute({
        schema,
        document: personalTimelineLanguageQuery,
        contextValue: ctx,
        variableValues: { languages: [] },
      });
      assertEquals(all.errors, undefined);
      const allIds = (all.data as TimelineData).personalTimeline.edges.map(
        (e) => e.node.id,
      );
      assert(
        allIds.includes(encodeGlobalID("Note", enPost.id)) &&
          allIds.includes(encodeGlobalID("Note", enGbPost.id)) &&
          allIds.includes(encodeGlobalID("Note", jaPost.id)),
        "empty languages returns all posts",
      );
    });
  },
});
