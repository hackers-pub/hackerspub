import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  insertAccountWithActor,
  insertNotePost,
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
