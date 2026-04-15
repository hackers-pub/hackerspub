import { assertEquals } from "@std/assert/equals";
import { and, eq } from "drizzle-orm";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { follow } from "@hackerspub/models/following";
import { blockingTable, followingTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const followActorMutation = parse(`
  mutation FollowActor($actorId: ID!) {
    followActor(input: { actorId: $actorId }) {
      __typename
      ... on FollowActorPayload {
        followee { id }
        follower { id }
      }
      ... on InvalidInputError { inputPath }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`);

const unfollowActorMutation = parse(`
  mutation UnfollowActor($actorId: ID!) {
    unfollowActor(input: { actorId: $actorId }) {
      __typename
      ... on UnfollowActorPayload {
        followee { id }
        follower { id }
      }
      ... on InvalidInputError { inputPath }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`);

const removeFollowerMutation = parse(`
  mutation RemoveFollower($actorId: ID!) {
    removeFollower(input: { actorId: $actorId }) {
      __typename
      ... on RemoveFollowerPayload {
        followee { id }
        follower { id }
      }
      ... on InvalidInputError { inputPath }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`);

const blockActorMutation = parse(`
  mutation BlockActor($actorId: ID!) {
    blockActor(input: { actorId: $actorId }) {
      __typename
      ... on BlockActorPayload {
        blocker { id }
        blockee { id }
      }
      ... on InvalidInputError { inputPath }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`);

const unblockActorMutation = parse(`
  mutation UnblockActor($actorId: ID!) {
    unblockActor(input: { actorId: $actorId }) {
      __typename
      ... on UnblockActorPayload {
        blocker { id }
        blockee { id }
      }
      ... on InvalidInputError { inputPath }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`);

Deno.test({
  name: "followActor rejects attempts to follow yourself",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "selffollow",
        name: "Self Follow",
        email: "selffollow@example.com",
      });

      const result = await execute({
        schema,
        document: followActorMutation,
        variableValues: {
          actorId: encodeGlobalID("Actor", account.actor.id),
        },
        contextValue: makeUserContext(tx, account.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as {
          followActor: { __typename: string; inputPath?: string };
        }).followActor,
        {
          __typename: "InvalidInputError",
          inputPath: "actorId",
        },
      );
    });
  },
});

Deno.test({
  name: "followActor and unfollowActor round-trip through GraphQL",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const follower = await insertAccountWithActor(tx, {
        username: "graphqlfollower",
        name: "GraphQL Follower",
        email: "graphqlfollower@example.com",
      });
      const followee = await insertAccountWithActor(tx, {
        username: "graphqlfollowee",
        name: "GraphQL Followee",
        email: "graphqlfollowee@example.com",
      });
      const actorId = encodeGlobalID("Actor", followee.actor.id);

      const followResult = await execute({
        schema,
        document: followActorMutation,
        variableValues: { actorId },
        contextValue: makeUserContext(tx, follower.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(followResult.errors, undefined);
      assertEquals(
        (followResult.data as {
          followActor: { __typename: string; followee?: { id: string } };
        }).followActor.__typename,
        "FollowActorPayload",
      );

      const storedAfterFollow = await tx.query.followingTable.findFirst({
        where: {
          followerId: follower.actor.id,
          followeeId: followee.actor.id,
        },
      });
      assertEquals(storedAfterFollow?.accepted != null, true);

      const unfollowResult = await execute({
        schema,
        document: unfollowActorMutation,
        variableValues: { actorId },
        contextValue: makeUserContext(tx, follower.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(unfollowResult.errors, undefined);
      assertEquals(
        (unfollowResult.data as {
          unfollowActor: { __typename: string };
        }).unfollowActor.__typename,
        "UnfollowActorPayload",
      );

      const storedAfterUnfollow = await tx.query.followingTable.findFirst({
        where: {
          followerId: follower.actor.id,
          followeeId: followee.actor.id,
        },
      });
      assertEquals(storedAfterUnfollow, undefined);
    });
  },
});

Deno.test({
  name: "removeFollower removes an existing follower relation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const followee = await insertAccountWithActor(tx, {
        username: "graphqlremovefollowee",
        name: "GraphQL Remove Followee",
        email: "graphqlremovefollowee@example.com",
      });
      const follower = await insertAccountWithActor(tx, {
        username: "graphqlremovefollower",
        name: "GraphQL Remove Follower",
        email: "graphqlremovefollower@example.com",
      });

      await follow(fedCtx, follower.account, followee.actor);

      const result = await execute({
        schema,
        document: removeFollowerMutation,
        variableValues: {
          actorId: encodeGlobalID("Actor", follower.actor.id),
        },
        contextValue: makeUserContext(tx, followee.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(
        (result.data as {
          removeFollower: { __typename: string };
        }).removeFollower.__typename,
        "RemoveFollowerPayload",
      );

      const stored = await tx.select().from(followingTable).where(and(
        eq(followingTable.followerId, follower.actor.id),
        eq(followingTable.followeeId, followee.actor.id),
      ));
      assertEquals(stored, []);
    });
  },
});

Deno.test({
  name: "blockActor and unblockActor round-trip through GraphQL",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const blocker = await insertAccountWithActor(tx, {
        username: "graphqlblocker",
        name: "GraphQL Blocker",
        email: "graphqlblocker@example.com",
      });
      const blockee = await insertAccountWithActor(tx, {
        username: "graphqlblockee",
        name: "GraphQL Blockee",
        email: "graphqlblockee@example.com",
      });
      const actorId = encodeGlobalID("Actor", blockee.actor.id);

      const blockResult = await execute({
        schema,
        document: blockActorMutation,
        variableValues: { actorId },
        contextValue: makeUserContext(tx, blocker.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(blockResult.errors, undefined);
      assertEquals(
        (blockResult.data as { blockActor: { __typename: string } }).blockActor
          .__typename,
        "BlockActorPayload",
      );

      const storedAfterBlock = await tx.select().from(blockingTable).where(and(
        eq(blockingTable.blockerId, blocker.actor.id),
        eq(blockingTable.blockeeId, blockee.actor.id),
      ));
      assertEquals(storedAfterBlock.length, 1);
      assertEquals(storedAfterBlock[0].blockeeId, blockee.actor.id);

      const unblockResult = await execute({
        schema,
        document: unblockActorMutation,
        variableValues: { actorId },
        contextValue: makeUserContext(tx, blocker.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(unblockResult.errors, undefined);
      assertEquals(
        (unblockResult.data as { unblockActor: { __typename: string } })
          .unblockActor.__typename,
        "UnblockActorPayload",
      );

      const storedAfterUnblock = await tx.select().from(blockingTable).where(
        and(
          eq(blockingTable.blockerId, blocker.actor.id),
          eq(blockingTable.blockeeId, blockee.actor.id),
        ),
      );
      assertEquals(storedAfterUnblock, []);
    });
  },
});
