import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { createBookmark, deleteBookmark } from "@hackerspub/models/bookmark";
import { sharePost } from "@hackerspub/models/post";
import { followingTable } from "@hackerspub/models/schema";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertMention,
  insertNotePost,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const addReactionMutation = parse(`
  mutation AddReactionToPost($postId: ID!, $emoji: String!) {
    addReactionToPost(input: { postId: $postId, emoji: $emoji }) {
      __typename
      ... on AddReactionToPostPayload {
        reaction {
          id
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

const shareMutation = parse(`
  mutation SharePost($postId: ID!) {
    sharePost(input: { postId: $postId }) {
      __typename
      ... on SharePostPayload {
        originalPost {
          id
        }
        share {
          id
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

const unshareMutation = parse(`
  mutation UnsharePost($postId: ID!) {
    unsharePost(input: { postId: $postId }) {
      __typename
      ... on UnsharePostPayload {
        originalPost {
          id
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

const pinMutation = parse(`
  mutation PinPost($postId: ID!) {
    pinPost(input: { postId: $postId }) {
      __typename
      ... on PinPostPayload {
        post {
          id
          viewerHasPinned
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

const unpinMutation = parse(`
  mutation UnpinPost($postId: ID!) {
    unpinPost(input: { postId: $postId }) {
      __typename
      ... on UnpinPostPayload {
        post {
          id
          viewerHasPinned
        }
        unpinnedPostId
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`);

Deno.test({
  name: "addReactionToPost rejects posts not visible to the viewer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "hiddenauthor",
        name: "Hidden Author",
        email: "hiddenauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "hiddenviewer",
        name: "Hidden Viewer",
        email: "hiddenviewer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Followers-only note",
        visibility: "followers",
      });

      const result = await execute({
        schema,
        document: addReactionMutation,
        variableValues: {
          postId: encodeGlobalID("Note", post.id),
          emoji: "❤️",
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as {
          addReactionToPost: { __typename: string; inputPath?: string };
        }).addReactionToPost,
        {
          __typename: "InvalidInputError",
          inputPath: "postId",
        },
      );
    });
  },
});

Deno.test({
  name: "pinPost and unpinPost round-trip through GraphQL",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "graphqlpinauthor",
        name: "GraphQL Pin Author",
        email: "graphqlpinauthor@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "GraphQL pin target",
      });
      const postId = encodeGlobalID("Note", post.id);

      const pinResult = await execute({
        schema,
        document: pinMutation,
        variableValues: { postId },
        contextValue: makeUserContext(tx, author.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(pinResult.errors, undefined);

      const pinPayload = (pinResult.data as {
        pinPost: {
          __typename: string;
          post?: { id: string; viewerHasPinned: boolean };
        };
      }).pinPost;
      assertEquals(pinPayload.__typename, "PinPostPayload");
      assertEquals(pinPayload.post, {
        id: postId,
        viewerHasPinned: true,
      });

      const pinsAfterPin = await tx.query.pinTable.findMany({
        where: {
          actorId: author.actor.id,
          postId: post.id,
        },
      });
      assertEquals(pinsAfterPin.length, 1);

      const unpinResult = await execute({
        schema,
        document: unpinMutation,
        variableValues: { postId },
        contextValue: makeUserContext(tx, author.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(unpinResult.errors, undefined);

      const unpinPayload = (unpinResult.data as {
        unpinPost: {
          __typename: string;
          post?: { id: string; viewerHasPinned: boolean };
          unpinnedPostId?: string;
        };
      }).unpinPost;
      assertEquals(unpinPayload.__typename, "UnpinPostPayload");
      assertEquals(unpinPayload.post, {
        id: postId,
        viewerHasPinned: false,
      });
      assertEquals(unpinPayload.unpinnedPostId, postId);

      const pinsAfterUnpin = await tx.query.pinTable.findMany({
        where: {
          actorId: author.actor.id,
          postId: post.id,
        },
      });
      assertEquals(pinsAfterUnpin, []);
    });
  },
});

Deno.test({
  name: "pinPost rejects posts that cannot be pinned by the viewer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "graphqlpinowner",
        name: "GraphQL Pin Owner",
        email: "graphqlpinowner@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "graphqlpinviewer",
        name: "GraphQL Pin Viewer",
        email: "graphqlpinviewer@example.com",
      });
      const { post: otherPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Someone else's post",
      });
      const { post: followersPost } = await insertNotePost(tx, {
        account: viewer.account,
        content: "Followers-only self post",
        visibility: "followers",
      });

      for (const post of [otherPost, followersPost]) {
        const result = await execute({
          schema,
          document: pinMutation,
          variableValues: { postId: encodeGlobalID("Note", post.id) },
          contextValue: makeUserContext(tx, viewer.account),
          onError: "NO_PROPAGATE",
        });

        assertEquals(result.errors, undefined);
        assertEquals(
          (result.data as {
            pinPost: { __typename: string; inputPath?: string };
          }).pinPost,
          {
            __typename: "InvalidInputError",
            inputPath: "postId",
          },
        );
      }
    });
  },
});

Deno.test({
  name: "unpinPost rejects posts the viewer has not pinned",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "graphqlunpinowner",
        name: "GraphQL Unpin Owner",
        email: "graphqlunpinowner@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "graphqlunpinviewer",
        name: "GraphQL Unpin Viewer",
        email: "graphqlunpinviewer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Hidden unpin target",
        visibility: "followers",
      });

      const result = await execute({
        schema,
        document: unpinMutation,
        variableValues: { postId: encodeGlobalID("Note", post.id) },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as {
          unpinPost: { __typename: string; inputPath?: string };
        }).unpinPost,
        {
          __typename: "InvalidInputError",
          inputPath: "postId",
        },
      );
    });
  },
});

Deno.test({
  name: "pinPost requires authentication",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "graphqlpinguest",
        name: "GraphQL Pin Guest",
        email: "graphqlpinguest@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Guest pin target",
      });

      const result = await execute({
        schema,
        document: pinMutation,
        variableValues: { postId: encodeGlobalID("Note", post.id) },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as {
          pinPost: { __typename: string };
        }).pinPost.__typename,
        "NotAuthenticatedError",
      );
    });
  },
});

Deno.test({
  name: "addReactionToPost returns the created reaction for visible posts",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "reactionauthor",
        name: "Reaction Author",
        email: "reactionauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "reactionviewer",
        name: "Reaction Viewer",
        email: "reactionviewer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Public note",
      });

      const result = await execute({
        schema,
        document: addReactionMutation,
        variableValues: {
          postId: encodeGlobalID("Note", post.id),
          emoji: "🎉",
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const payload = (result.data as {
        addReactionToPost: {
          __typename: string;
          reaction?: { id: string } | null;
        };
      }).addReactionToPost;
      assertEquals(payload.__typename, "AddReactionToPostPayload");
      assert(payload.reaction?.id != null);

      const reactions = await tx.query.reactionTable.findMany({
        where: {
          postId: post.id,
          actorId: viewer.actor.id,
          emoji: "🎉",
        },
      });
      assertEquals(reactions.length, 1);
    });
  },
});

Deno.test({
  name: "sharePost and unsharePost round-trip through GraphQL",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "graphqlshareauthor",
        name: "GraphQL Share Author",
        email: "graphqlshareauthor@example.com",
      });
      const sharer = await insertAccountWithActor(tx, {
        username: "graphqlsharer",
        name: "GraphQL Sharer",
        email: "graphqlsharer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "GraphQL share target",
      });
      const postId = encodeGlobalID("Note", post.id);

      const shareResult = await execute({
        schema,
        document: shareMutation,
        variableValues: { postId },
        contextValue: makeUserContext(tx, sharer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(shareResult.errors, undefined);

      const sharePayload = (shareResult.data as {
        sharePost: {
          __typename: string;
          originalPost?: { id: string };
          share?: { id: string };
        };
      }).sharePost;
      assertEquals(sharePayload.__typename, "SharePostPayload");
      assertEquals(sharePayload.originalPost?.id, postId);
      assert(sharePayload.share?.id != null);

      const sharesAfterShare = await tx.query.postTable.findMany({
        where: {
          actorId: sharer.actor.id,
          sharedPostId: post.id,
        },
      });
      assertEquals(sharesAfterShare.length, 1);

      const unshareResult = await execute({
        schema,
        document: unshareMutation,
        variableValues: { postId },
        contextValue: makeUserContext(tx, sharer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(unshareResult.errors, undefined);

      const unsharePayload = (unshareResult.data as {
        unsharePost: {
          __typename: string;
          originalPost?: { id: string };
        };
      }).unsharePost;
      assertEquals(unsharePayload.__typename, "UnsharePostPayload");
      assertEquals(unsharePayload.originalPost?.id, postId);

      const sharesAfterUnshare = await tx.query.postTable.findMany({
        where: {
          actorId: sharer.actor.id,
          sharedPostId: post.id,
        },
      });
      assertEquals(sharesAfterUnshare, []);
    });
  },
});

const viewerHasMultiQuery = parse(`
  query ViewerHasMulti($a: ID!, $b: ID!, $c: ID!) {
    a: node(id: $a) {
      ... on Post {
        id
        viewerHasShared
        viewerHasBookmarked
      }
    }
    b: node(id: $b) {
      ... on Post {
        id
        viewerHasShared
        viewerHasBookmarked
      }
    }
    c: node(id: $c) {
      ... on Post {
        id
        viewerHasShared
        viewerHasBookmarked
      }
    }
  }
`);

Deno.test({
  name: "viewerHasShared and viewerHasBookmarked reflect viewer state per post",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "viewerhasauthor",
        name: "ViewerHas Author",
        email: "viewerhasauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "viewerhasviewer",
        name: "ViewerHas Viewer",
        email: "viewerhasviewer@example.com",
      });

      const { post: sharedPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Will be shared",
      });
      const { post: bookmarkedPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Will be bookmarked",
      });
      const { post: untouchedPost } = await insertNotePost(tx, {
        account: author.account,
        content: "Untouched",
      });

      const fedCtx = createFedCtx(tx);
      await sharePost(fedCtx, viewer.account, {
        ...sharedPost,
        actor: author.actor,
      });
      await createBookmark(tx, viewer.account, bookmarkedPost);

      const sharedId = encodeGlobalID("Note", sharedPost.id);
      const bookmarkedId = encodeGlobalID("Note", bookmarkedPost.id);
      const untouchedId = encodeGlobalID("Note", untouchedPost.id);

      const result = await execute({
        schema,
        document: viewerHasMultiQuery,
        variableValues: {
          a: sharedId,
          b: bookmarkedId,
          c: untouchedId,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const data = result.data as {
        a: {
          id: string;
          viewerHasShared: boolean;
          viewerHasBookmarked: boolean;
        };
        b: {
          id: string;
          viewerHasShared: boolean;
          viewerHasBookmarked: boolean;
        };
        c: {
          id: string;
          viewerHasShared: boolean;
          viewerHasBookmarked: boolean;
        };
      };

      assertEquals(data.a, {
        id: sharedId,
        viewerHasShared: true,
        viewerHasBookmarked: false,
      });
      assertEquals(data.b, {
        id: bookmarkedId,
        viewerHasShared: false,
        viewerHasBookmarked: true,
      });
      assertEquals(data.c, {
        id: untouchedId,
        viewerHasShared: false,
        viewerHasBookmarked: false,
      });
    });
  },
});

Deno.test({
  name: "viewerHasShared and viewerHasBookmarked are false for guest viewers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "viewerhasguestauthor",
        name: "ViewerHas Guest Author",
        email: "viewerhasguestauthor@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Guest can read but has no state",
      });
      const postId = encodeGlobalID("Note", post.id);

      const result = await execute({
        schema,
        document: viewerHasMultiQuery,
        variableValues: {
          a: postId,
          b: postId,
          c: postId,
        },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const data = result.data as {
        a: { viewerHasShared: boolean; viewerHasBookmarked: boolean };
      };
      assertEquals(data.a.viewerHasShared, false);
      assertEquals(data.a.viewerHasBookmarked, false);
    });
  },
});

const bookmarkAndUnbookmarkMutation = parse(`
  mutation BookmarkRoundTrip($postId: ID!) {
    first: bookmarkPost(input: { postId: $postId }) {
      __typename
      ... on BookmarkPostPayload {
        post {
          viewerHasBookmarked
        }
      }
    }
    second: unbookmarkPost(input: { postId: $postId }) {
      __typename
      ... on UnbookmarkPostPayload {
        post {
          viewerHasBookmarked
        }
      }
    }
  }
`);

Deno.test({
  name:
    "viewerHasBookmarked reflects post-mutation state across serial mutations",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "viewerhasinvalauthor",
        name: "ViewerHas Invalidation Author",
        email: "viewerhasinvalauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "viewerhasinvalviewer",
        name: "ViewerHas Invalidation Viewer",
        email: "viewerhasinvalviewer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Bookmark me, then don't",
      });
      const postId = encodeGlobalID("Note", post.id);

      const result = await execute({
        schema,
        document: bookmarkAndUnbookmarkMutation,
        variableValues: { postId },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const data = result.data as {
        first: {
          __typename: string;
          post?: { viewerHasBookmarked: boolean };
        };
        second: {
          __typename: string;
          post?: { viewerHasBookmarked: boolean };
        };
      };
      assertEquals(data.first.__typename, "BookmarkPostPayload");
      assertEquals(data.first.post?.viewerHasBookmarked, true);
      assertEquals(data.second.__typename, "UnbookmarkPostPayload");
      assertEquals(data.second.post?.viewerHasBookmarked, false);
    });
  },
});

const timelineWithoutIdQuery = parse(`
  query TimelineWithoutId {
    publicTimeline(first: 5, local: true, withoutShares: true) {
      edges {
        node {
          viewerHasShared
          viewerHasBookmarked
          viewerHasPinned
        }
      }
    }
  }
`);

Deno.test({
  name:
    "viewerHas* fields reflect state when id is not in the GraphQL selection",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const author = await insertAccountWithActor(tx, {
        username: "viewerhasnoidauthor",
        name: "ViewerHas NoId Author",
        email: "viewerhasnoidauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "viewerhasnoidviewer",
        name: "ViewerHas NoId Viewer",
        email: "viewerhasnoidviewer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Will be shared and bookmarked, queried without id",
      });

      await sharePost(fedCtx, viewer.account, {
        ...post,
        actor: author.actor,
      });
      await createBookmark(tx, viewer.account, post);

      const result = await execute({
        schema,
        document: timelineWithoutIdQuery,
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const edges = (result.data as {
        publicTimeline: {
          edges: {
            node: {
              viewerHasShared: boolean;
              viewerHasBookmarked: boolean;
              viewerHasPinned: boolean;
            };
          }[];
        };
      }).publicTimeline.edges;

      // The original post (not the share) should reflect the viewer's state
      // even though `id` was not requested in the selection set. This guards
      // against `post.id` becoming undefined inside the t.loadable resolve
      // function, which would silently make every viewerHas* return false.
      const original = edges.find((e) =>
        e.node.viewerHasBookmarked || e.node.viewerHasShared
      );
      assertEquals(original?.node.viewerHasShared, true);
      assertEquals(original?.node.viewerHasBookmarked, true);
    });
  },
});

const bookmarkCountQuery = parse(`
  query BookmarkCount($id: ID!) {
    node(id: $id) {
      ... on Post {
        engagementStats {
          bookmarks
        }
      }
    }
  }
`);

Deno.test({
  name: "engagementStats.bookmarks counts bookmark rows for the post",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "bookmarkstatsauthor",
        name: "BookmarkStats Author",
        email: "bookmarkstatsauthor@example.com",
      });
      const viewerA = await insertAccountWithActor(tx, {
        username: "bookmarkstatsviewera",
        name: "BookmarkStats Viewer A",
        email: "bookmarkstatsviewera@example.com",
      });
      const viewerB = await insertAccountWithActor(tx, {
        username: "bookmarkstatsviewerb",
        name: "BookmarkStats Viewer B",
        email: "bookmarkstatsviewerb@example.com",
      });

      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Will be bookmarked",
      });
      const postId = encodeGlobalID("Note", post.id);

      const readCount = async (
        ctx:
          | ReturnType<typeof makeUserContext>
          | ReturnType<
            typeof makeGuestContext
          >,
      ): Promise<number> => {
        const result = await execute({
          schema,
          document: bookmarkCountQuery,
          variableValues: { id: postId },
          contextValue: ctx,
          onError: "NO_PROPAGATE",
        });
        assertEquals(result.errors, undefined);
        const data = result.data as {
          node: { engagementStats: { bookmarks: number } };
        };
        return data.node.engagementStats.bookmarks;
      };

      // Initially zero from every perspective.
      assertEquals(await readCount(makeGuestContext(tx)), 0);
      assertEquals(await readCount(makeUserContext(tx, viewerA.account)), 0);

      await createBookmark(tx, viewerA.account, post);
      await createBookmark(tx, viewerB.account, post);

      // Count is public and identical across viewers (bookmarker,
      // non-bookmarker, guest).
      assertEquals(await readCount(makeGuestContext(tx)), 2);
      assertEquals(await readCount(makeUserContext(tx, viewerA.account)), 2);
      assertEquals(await readCount(makeUserContext(tx, viewerB.account)), 2);
      assertEquals(await readCount(makeUserContext(tx, author.account)), 2);

      // Unbookmarking drops the count.
      await deleteBookmark(tx, viewerA.account, post);
      assertEquals(await readCount(makeGuestContext(tx)), 1);
      assertEquals(await readCount(makeUserContext(tx, viewerB.account)), 1);
    });
  },
});

const bookmarkRoundTripCountMutation = parse(`
  mutation BookmarkRoundTripCount($postId: ID!) {
    first: bookmarkPost(input: { postId: $postId }) {
      __typename
      ... on BookmarkPostPayload {
        post {
          engagementStats {
            bookmarks
          }
        }
      }
    }
    second: unbookmarkPost(input: { postId: $postId }) {
      __typename
      ... on UnbookmarkPostPayload {
        post {
          engagementStats {
            bookmarks
          }
        }
      }
    }
  }
`);

Deno.test({
  name:
    "engagementStats.bookmarks reflects post-mutation state across serial mutations",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "bookmarkstatsmutauthor",
        name: "BookmarkStatsMut Author",
        email: "bookmarkstatsmutauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "bookmarkstatsmutviewer",
        name: "BookmarkStatsMut Viewer",
        email: "bookmarkstatsmutviewer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Serial bookmark mutations",
      });

      const result = await execute({
        schema,
        document: bookmarkRoundTripCountMutation,
        variableValues: { postId: encodeGlobalID("Note", post.id) },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);

      const data = result.data as {
        first: {
          __typename: string;
          post?: { engagementStats: { bookmarks: number } };
        };
        second: {
          __typename: string;
          post?: { engagementStats: { bookmarks: number } };
        };
      };

      assertEquals(data.first.__typename, "BookmarkPostPayload");
      assertEquals(data.first.post?.engagementStats.bookmarks, 1);
      assertEquals(data.second.__typename, "UnbookmarkPostPayload");
      assertEquals(data.second.post?.engagementStats.bookmarks, 0);
    });
  },
});

const viewerActionPolicyQuery = parse(`
  query ViewerActionPolicy($id: ID!) {
    node(id: $id) {
      ... on Post {
        viewerCanReply
        viewerCanQuote
        viewerCanShare
      }
    }
  }
`);

interface ViewerActionPolicy {
  viewerCanReply: boolean;
  viewerCanQuote: boolean;
  viewerCanShare: boolean;
}

async function readPolicy(
  postId: string,
  contextValue:
    | ReturnType<typeof makeUserContext>
    | ReturnType<typeof makeGuestContext>,
): Promise<ViewerActionPolicy> {
  const result = await execute({
    schema,
    document: viewerActionPolicyQuery,
    variableValues: { id: postId },
    contextValue,
    onError: "NO_PROPAGATE",
  });
  assertEquals(result.errors, undefined);
  const data = result.data as { node: ViewerActionPolicy };
  return {
    viewerCanReply: data.node.viewerCanReply,
    viewerCanQuote: data.node.viewerCanQuote,
    viewerCanShare: data.node.viewerCanShare,
  };
}

Deno.test({
  name:
    "viewerCanReply/Quote/Share permit every signed-in viewer on public posts and deny guests",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "policypublicauthor",
        name: "Policy Public Author",
        email: "policypublicauthor@example.com",
      });
      const viewer = await insertAccountWithActor(tx, {
        username: "policypublicviewer",
        name: "Policy Public Viewer",
        email: "policypublicviewer@example.com",
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Public",
        visibility: "public",
      });
      const id = encodeGlobalID("Note", post.id);

      assertEquals(
        await readPolicy(id, makeUserContext(tx, author.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: true,
          viewerCanShare: true,
        },
      );
      assertEquals(
        await readPolicy(id, makeUserContext(tx, viewer.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: true,
          viewerCanShare: true,
        },
      );
      assertEquals(await readPolicy(id, makeGuestContext(tx)), {
        viewerCanReply: false,
        viewerCanQuote: false,
        viewerCanShare: false,
      });
    });
  },
});

Deno.test({
  name: "viewerCanQuote follows explicit quote policy on public posts",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "policyquoteauthor",
        name: "Policy Quote Author",
        email: "policyquoteauthor@example.com",
      });
      const follower = await insertAccountWithActor(tx, {
        username: "policyquotefollower",
        name: "Policy Quote Follower",
        email: "policyquotefollower@example.com",
      });
      const stranger = await insertAccountWithActor(tx, {
        username: "policyquotestranger",
        name: "Policy Quote Stranger",
        email: "policyquotestranger@example.com",
      });
      await tx.insert(followingTable).values({
        iri:
          `https://example.com/following/${follower.actor.id}/${author.actor.id}`,
        followerId: follower.actor.id,
        followeeId: author.actor.id,
        accepted: new Date(),
      });
      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Follower-quotable",
        visibility: "public",
        quotePolicy: "followers",
      });
      const id = encodeGlobalID("Note", post.id);

      assertEquals(
        await readPolicy(id, makeUserContext(tx, author.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: true,
          viewerCanShare: true,
        },
      );
      assertEquals(
        await readPolicy(id, makeUserContext(tx, follower.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: true,
          viewerCanShare: true,
        },
      );
      assertEquals(
        await readPolicy(id, makeUserContext(tx, stranger.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: false,
          viewerCanShare: true,
        },
      );
    });
  },
});

Deno.test({
  name:
    "viewerCanReply/Quote/Share on followers-only posts: only author may quote or share; followers and mentions may reply",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "policyfollowersauthor",
        name: "Policy Followers Author",
        email: "policyfollowersauthor@example.com",
      });
      const follower = await insertAccountWithActor(tx, {
        username: "policyfollowersfollower",
        name: "Policy Followers Follower",
        email: "policyfollowersfollower@example.com",
      });
      const mentioned = await insertAccountWithActor(tx, {
        username: "policyfollowersmentioned",
        name: "Policy Followers Mentioned",
        email: "policyfollowersmentioned@example.com",
      });
      const stranger = await insertAccountWithActor(tx, {
        username: "policyfollowersstranger",
        name: "Policy Followers Stranger",
        email: "policyfollowersstranger@example.com",
      });

      await tx.insert(followingTable).values({
        iri:
          `https://example.com/following/${follower.actor.id}/${author.actor.id}`,
        followerId: follower.actor.id,
        followeeId: author.actor.id,
        accepted: new Date(),
      });

      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Followers-only",
        visibility: "followers",
      });
      await insertMention(tx, {
        postId: post.id,
        actorId: mentioned.actor.id,
      });
      const id = encodeGlobalID("Note", post.id);

      assertEquals(
        await readPolicy(id, makeUserContext(tx, author.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: true,
          viewerCanShare: true,
        },
      );
      assertEquals(
        await readPolicy(id, makeUserContext(tx, follower.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: false,
          viewerCanShare: false,
        },
      );
      assertEquals(
        await readPolicy(id, makeUserContext(tx, mentioned.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: false,
          viewerCanShare: false,
        },
      );
      assertEquals(
        await readPolicy(id, makeUserContext(tx, stranger.account)),
        {
          viewerCanReply: false,
          viewerCanQuote: false,
          viewerCanShare: false,
        },
      );
      assertEquals(await readPolicy(id, makeGuestContext(tx)), {
        viewerCanReply: false,
        viewerCanQuote: false,
        viewerCanShare: false,
      });
    });
  },
});

Deno.test({
  name:
    "viewerCanReply/Quote/Share on direct posts: author may quote; mentions may reply; nobody may share",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "policydirectauthor",
        name: "Policy Direct Author",
        email: "policydirectauthor@example.com",
      });
      const mentioned = await insertAccountWithActor(tx, {
        username: "policydirectmentioned",
        name: "Policy Direct Mentioned",
        email: "policydirectmentioned@example.com",
      });
      const stranger = await insertAccountWithActor(tx, {
        username: "policydirectstranger",
        name: "Policy Direct Stranger",
        email: "policydirectstranger@example.com",
      });

      const { post } = await insertNotePost(tx, {
        account: author.account,
        content: "Direct message",
        visibility: "direct",
      });
      await insertMention(tx, {
        postId: post.id,
        actorId: mentioned.actor.id,
      });
      const id = encodeGlobalID("Note", post.id);

      assertEquals(
        await readPolicy(id, makeUserContext(tx, author.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: true,
          viewerCanShare: false,
        },
      );
      assertEquals(
        await readPolicy(id, makeUserContext(tx, mentioned.account)),
        {
          viewerCanReply: true,
          viewerCanQuote: false,
          viewerCanShare: false,
        },
      );
      assertEquals(
        await readPolicy(id, makeUserContext(tx, stranger.account)),
        {
          viewerCanReply: false,
          viewerCanQuote: false,
          viewerCanShare: false,
        },
      );
    });
  },
});
