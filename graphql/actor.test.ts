import { assertEquals } from "@std/assert/equals";
import { and, eq, or } from "drizzle-orm";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { block } from "@hackerspub/models/blocking";
import { follow } from "@hackerspub/models/following";
import { blockingTable, followingTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  makeGuestContext,
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
        blocker {
          id
          viewerBlocks
          blocksViewer
          viewerFollows
          followsViewer
          followees {
            totalCount
          }
          followers {
            totalCount
          }
        }
        blockee {
          id
          viewerBlocks
          blocksViewer
          viewerFollows
          followsViewer
          followees {
            totalCount
          }
          followers {
            totalCount
          }
        }
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
        blocker {
          id
          viewerBlocks
          blocksViewer
          viewerFollows
          followsViewer
          followees {
            totalCount
          }
          followers {
            totalCount
          }
        }
        blockee {
          id
          viewerBlocks
          blocksViewer
          viewerFollows
          followsViewer
          followees {
            totalCount
          }
          followers {
            totalCount
          }
        }
      }
      ... on InvalidInputError { inputPath }
      ... on NotAuthenticatedError { notAuthenticated }
    }
  }
`);

const actorBlockStateQuery = parse(`
  query ActorBlockState($uuid: UUID!) {
    actorByUuid(uuid: $uuid) {
      id
      viewerBlocks
      blocksViewer
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
      const fedCtx = createFedCtx(tx);
      const actorId = encodeGlobalID("Actor", blockee.actor.id);
      const expectedBlockeePayload = (viewerBlocks: boolean) => ({
        id: actorId,
        viewerBlocks,
        blocksViewer: false,
        viewerFollows: false,
        followsViewer: false,
        followees: { totalCount: 0 },
        followers: { totalCount: 0 },
      });

      await follow(fedCtx, blocker.account, blockee.actor);
      await follow(fedCtx, blockee.account, blocker.actor);

      const storedBeforeBlock = await tx.select().from(followingTable).where(
        or(
          and(
            eq(followingTable.followerId, blocker.actor.id),
            eq(followingTable.followeeId, blockee.actor.id),
          ),
          and(
            eq(followingTable.followerId, blockee.actor.id),
            eq(followingTable.followeeId, blocker.actor.id),
          ),
        ),
      );
      assertEquals(storedBeforeBlock.length, 2);

      const blockResult = await execute({
        schema,
        document: blockActorMutation,
        variableValues: { actorId },
        contextValue: makeUserContext(tx, blocker.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(blockResult.errors, undefined);
      const blockActorPayload = (blockResult.data as {
        blockActor: {
          __typename: string;
          blockee?: {
            id: string;
            viewerBlocks: boolean;
            blocksViewer: boolean;
            viewerFollows: boolean;
            followsViewer: boolean;
            followees: { totalCount: number };
            followers: { totalCount: number };
          };
        };
      }).blockActor;
      assertEquals(blockActorPayload.__typename, "BlockActorPayload");
      assertEquals(
        blockActorPayload.blockee,
        expectedBlockeePayload(true),
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
      const unblockActorPayload = (unblockResult.data as {
        unblockActor: {
          __typename: string;
          blockee?: {
            id: string;
            viewerBlocks: boolean;
            blocksViewer: boolean;
            viewerFollows: boolean;
            followsViewer: boolean;
            followees: { totalCount: number };
            followers: { totalCount: number };
          };
        };
      }).unblockActor;
      assertEquals(unblockActorPayload.__typename, "UnblockActorPayload");
      assertEquals(
        unblockActorPayload.blockee,
        expectedBlockeePayload(false),
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

Deno.test({
  name: "Actor block fields expose outgoing and incoming viewer block state",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const blocker = await insertAccountWithActor(tx, {
        username: "graphqlstateblocker",
        name: "GraphQL State Blocker",
        email: "graphqlstateblocker@example.com",
      });
      const blockee = await insertAccountWithActor(tx, {
        username: "graphqlstateblockee",
        name: "GraphQL State Blockee",
        email: "graphqlstateblockee@example.com",
      });
      const actorId = encodeGlobalID("Actor", blockee.actor.id);

      const beforeBlock = await execute({
        schema,
        document: actorBlockStateQuery,
        variableValues: { uuid: blockee.actor.id },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });

      assertEquals(beforeBlock.errors, undefined);
      assertEquals(beforeBlock.data, {
        actorByUuid: {
          id: actorId,
          viewerBlocks: false,
          blocksViewer: false,
        },
      });

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

      const guestAfterBlock = await execute({
        schema,
        document: actorBlockStateQuery,
        variableValues: { uuid: blockee.actor.id },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });

      assertEquals(guestAfterBlock.errors, undefined);
      assertEquals(guestAfterBlock.data, {
        actorByUuid: {
          id: actorId,
          viewerBlocks: false,
          blocksViewer: false,
        },
      });

      const outgoingState = await execute({
        schema,
        document: actorBlockStateQuery,
        variableValues: { uuid: blockee.actor.id },
        contextValue: makeUserContext(tx, blocker.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(outgoingState.errors, undefined);
      assertEquals(outgoingState.data, {
        actorByUuid: {
          id: actorId,
          viewerBlocks: true,
          blocksViewer: false,
        },
      });

      const incomingState = await execute({
        schema,
        document: actorBlockStateQuery,
        variableValues: { uuid: blocker.actor.id },
        contextValue: makeUserContext(tx, blockee.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(incomingState.errors, undefined);
      assertEquals(incomingState.data, {
        actorByUuid: {
          id: encodeGlobalID("Actor", blocker.actor.id),
          viewerBlocks: false,
          blocksViewer: true,
        },
      });
    });
  },
});

const viewerFollowsBatchQuery = parse(`
  query ViewerFollowsBatch($a: UUID!, $b: UUID!, $c: UUID!) {
    a: actorByUuid(uuid: $a) { id viewerFollows }
    b: actorByUuid(uuid: $b) { id viewerFollows }
    c: actorByUuid(uuid: $c) { id viewerFollows }
  }
`);

const mutualFollowersQuery = parse(`
  query MutualFollowers($uuid: UUID!) {
    actorByUuid(uuid: $uuid) {
      mutualFollowers(first: 10) {
        totalCount
        edges { node { username } }
      }
    }
  }
`);

const followRelationshipBatchQuery = parse(`
  query FollowRelationshipBatch($a: UUID!, $b: UUID!, $c: UUID!) {
    a: actorByUuid(uuid: $a) { id viewerFollows followsViewer }
    b: actorByUuid(uuid: $b) { id viewerFollows followsViewer }
    c: actorByUuid(uuid: $c) { id viewerFollows followsViewer }
  }
`);

const viewerBlocksBatchQuery = parse(`
  query ViewerBlocksBatch($a: UUID!, $b: UUID!, $c: UUID!) {
    a: actorByUuid(uuid: $a) { id viewerBlocks }
    b: actorByUuid(uuid: $b) { id viewerBlocks }
    c: actorByUuid(uuid: $c) { id viewerBlocks }
  }
`);

const blockRelationshipBatchQuery = parse(`
  query BlockRelationshipBatch($a: UUID!, $b: UUID!, $c: UUID!) {
    a: actorByUuid(uuid: $a) { id viewerBlocks blocksViewer }
    b: actorByUuid(uuid: $b) { id viewerBlocks blocksViewer }
    c: actorByUuid(uuid: $c) { id viewerBlocks blocksViewer }
  }
`);

Deno.test({
  name: "Actor.viewerFollows returns the right state per actor when batched",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const viewer = await insertAccountWithActor(tx, {
        username: "vfviewer",
        name: "VF Viewer",
        email: "vfviewer@example.com",
      });
      const followed = await insertAccountWithActor(tx, {
        username: "vffollowed",
        name: "VF Followed",
        email: "vffollowed@example.com",
      });
      const notFollowed = await insertAccountWithActor(tx, {
        username: "vfnotfollowed",
        name: "VF Not Followed",
        email: "vfnotfollowed@example.com",
      });
      const stranger = await insertAccountWithActor(tx, {
        username: "vfstranger",
        name: "VF Stranger",
        email: "vfstranger@example.com",
      });

      const fedCtx = createFedCtx(tx);
      await follow(fedCtx, viewer.account, followed.actor);

      const result = await execute({
        schema,
        document: viewerFollowsBatchQuery,
        variableValues: {
          a: followed.actor.id,
          b: notFollowed.actor.id,
          c: stranger.actor.id,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(result.data, {
        a: {
          id: encodeGlobalID("Actor", followed.actor.id),
          viewerFollows: true,
        },
        b: {
          id: encodeGlobalID("Actor", notFollowed.actor.id),
          viewerFollows: false,
        },
        c: {
          id: encodeGlobalID("Actor", stranger.actor.id),
          viewerFollows: false,
        },
      });
    });
  },
});

Deno.test({
  name:
    "Actor.mutualFollowers returns followers the viewer also follows, and is " +
    "empty for guests and for the viewer's own profile",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const viewer = await insertAccountWithActor(tx, {
        username: "mfviewer",
        name: "MF Viewer",
        email: "mfviewer@example.com",
      });
      const profile = await insertAccountWithActor(tx, {
        username: "mfprofile",
        name: "MF Profile",
        email: "mfprofile@example.com",
      });
      const mutual = await insertAccountWithActor(tx, {
        username: "mfmutual",
        name: "MF Mutual",
        email: "mfmutual@example.com",
      });
      const strangerFollower = await insertAccountWithActor(tx, {
        username: "mfstrangerfollower",
        name: "MF Stranger Follower",
        email: "mfstrangerfollower@example.com",
      });
      const followeeOnly = await insertAccountWithActor(tx, {
        username: "mffolloweeonly",
        name: "MF Followee Only",
        email: "mffolloweeonly@example.com",
      });

      const fedCtx = createFedCtx(tx);
      // `mutual` is the only "follower you know": the viewer follows them and
      // they follow the profile.
      await follow(fedCtx, viewer.account, mutual.actor);
      await follow(fedCtx, mutual.account, profile.actor);
      // `strangerFollower` follows the profile but the viewer does not follow
      // them, so they are excluded.
      await follow(fedCtx, strangerFollower.account, profile.actor);
      // The viewer follows `followeeOnly`, but they do not follow the profile,
      // so they are excluded too.
      await follow(fedCtx, viewer.account, followeeOnly.actor);

      const viewerResult = await execute({
        schema,
        document: mutualFollowersQuery,
        variableValues: { uuid: profile.actor.id },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(viewerResult.errors, undefined);
      assertEquals(viewerResult.data, {
        actorByUuid: {
          mutualFollowers: {
            totalCount: 1,
            edges: [{ node: { username: "mfmutual" } }],
          },
        },
      });

      const guestResult = await execute({
        schema,
        document: mutualFollowersQuery,
        variableValues: { uuid: profile.actor.id },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assertEquals(guestResult.errors, undefined);
      assertEquals(guestResult.data, {
        actorByUuid: {
          mutualFollowers: { totalCount: 0, edges: [] },
        },
      });

      // Viewing one's own profile yields no "followers you know".
      const ownResult = await execute({
        schema,
        document: mutualFollowersQuery,
        variableValues: { uuid: viewer.actor.id },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });
      assertEquals(ownResult.errors, undefined);
      assertEquals(ownResult.data, {
        actorByUuid: {
          mutualFollowers: { totalCount: 0, edges: [] },
        },
      });
    });
  },
});

Deno.test({
  name: "Actor.viewerFollows returns false for a guest viewer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const someone = await insertAccountWithActor(tx, {
        username: "vfguesttarget",
        name: "VF Guest Target",
        email: "vfguesttarget@example.com",
      });

      const result = await execute({
        schema,
        document: viewerFollowsBatchQuery,
        variableValues: {
          a: someone.actor.id,
          b: someone.actor.id,
          c: someone.actor.id,
        },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      const data = result.data as {
        a: { viewerFollows: boolean };
        b: { viewerFollows: boolean };
        c: { viewerFollows: boolean };
      };
      assertEquals(data.a.viewerFollows, false);
      assertEquals(data.b.viewerFollows, false);
      assertEquals(data.c.viewerFollows, false);
    });
  },
});

Deno.test({
  name:
    "Actor.viewerFollows and followsViewer are batched into independent results",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const viewer = await insertAccountWithActor(tx, {
        username: "frelviewer",
        name: "FREL Viewer",
        email: "frelviewer@example.com",
      });
      const followed = await insertAccountWithActor(tx, {
        username: "frelfollowed",
        name: "FREL Followed",
        email: "frelfollowed@example.com",
      });
      const fan = await insertAccountWithActor(tx, {
        username: "frelfan",
        name: "FREL Fan",
        email: "frelfan@example.com",
      });
      const stranger = await insertAccountWithActor(tx, {
        username: "frelstranger",
        name: "FREL Stranger",
        email: "frelstranger@example.com",
      });

      const fedCtx = createFedCtx(tx);
      // Viewer follows `followed` (viewerFollows=true on followed).
      await follow(fedCtx, viewer.account, followed.actor);
      // `fan` follows viewer (followsViewer=true on fan).
      await follow(fedCtx, fan.account, viewer.actor);

      const result = await execute({
        schema,
        document: followRelationshipBatchQuery,
        variableValues: {
          a: followed.actor.id,
          b: fan.actor.id,
          c: stranger.actor.id,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(result.data, {
        a: {
          id: encodeGlobalID("Actor", followed.actor.id),
          viewerFollows: true,
          followsViewer: false,
        },
        b: {
          id: encodeGlobalID("Actor", fan.actor.id),
          viewerFollows: false,
          followsViewer: true,
        },
        c: {
          id: encodeGlobalID("Actor", stranger.actor.id),
          viewerFollows: false,
          followsViewer: false,
        },
      });
    });
  },
});

Deno.test({
  name: "Actor.viewerBlocks returns the right state per actor when batched",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const viewer = await insertAccountWithActor(tx, {
        username: "vbviewer",
        name: "VB Viewer",
        email: "vbviewer@example.com",
      });
      const blocked = await insertAccountWithActor(tx, {
        username: "vbblocked",
        name: "VB Blocked",
        email: "vbblocked@example.com",
      });
      const notBlocked = await insertAccountWithActor(tx, {
        username: "vbnotblocked",
        name: "VB Not Blocked",
        email: "vbnotblocked@example.com",
      });
      const stranger = await insertAccountWithActor(tx, {
        username: "vbstranger",
        name: "VB Stranger",
        email: "vbstranger@example.com",
      });

      const fedCtx = createFedCtx(tx);
      await block(fedCtx, viewer.account, blocked.actor);

      const result = await execute({
        schema,
        document: viewerBlocksBatchQuery,
        variableValues: {
          a: blocked.actor.id,
          b: notBlocked.actor.id,
          c: stranger.actor.id,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(result.data, {
        a: {
          id: encodeGlobalID("Actor", blocked.actor.id),
          viewerBlocks: true,
        },
        b: {
          id: encodeGlobalID("Actor", notBlocked.actor.id),
          viewerBlocks: false,
        },
        c: {
          id: encodeGlobalID("Actor", stranger.actor.id),
          viewerBlocks: false,
        },
      });
    });
  },
});

Deno.test({
  name: "Actor.viewerBlocks returns false for a guest viewer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const someone = await insertAccountWithActor(tx, {
        username: "vbguesttarget",
        name: "VB Guest Target",
        email: "vbguesttarget@example.com",
      });

      const result = await execute({
        schema,
        document: viewerBlocksBatchQuery,
        variableValues: {
          a: someone.actor.id,
          b: someone.actor.id,
          c: someone.actor.id,
        },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      const data = result.data as {
        a: { viewerBlocks: boolean };
        b: { viewerBlocks: boolean };
        c: { viewerBlocks: boolean };
      };
      assertEquals(data.a.viewerBlocks, false);
      assertEquals(data.b.viewerBlocks, false);
      assertEquals(data.c.viewerBlocks, false);
    });
  },
});

Deno.test({
  name:
    "Actor.viewerBlocks and blocksViewer are batched into independent results",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const viewer = await insertAccountWithActor(tx, {
        username: "brelviewer",
        name: "BREL Viewer",
        email: "brelviewer@example.com",
      });
      const blocked = await insertAccountWithActor(tx, {
        username: "brelblocked",
        name: "BREL Blocked",
        email: "brelblocked@example.com",
      });
      const blocker = await insertAccountWithActor(tx, {
        username: "brelblocker",
        name: "BREL Blocker",
        email: "brelblocker@example.com",
      });
      const stranger = await insertAccountWithActor(tx, {
        username: "brelstranger",
        name: "BREL Stranger",
        email: "brelstranger@example.com",
      });

      const fedCtx = createFedCtx(tx);
      // Viewer blocks `blocked` (viewerBlocks=true on blocked).
      await block(fedCtx, viewer.account, blocked.actor);
      // `blocker` blocks viewer (blocksViewer=true on blocker).
      await block(fedCtx, blocker.account, viewer.actor);

      const result = await execute({
        schema,
        document: blockRelationshipBatchQuery,
        variableValues: {
          a: blocked.actor.id,
          b: blocker.actor.id,
          c: stranger.actor.id,
        },
        contextValue: makeUserContext(tx, viewer.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      assertEquals(result.data, {
        a: {
          id: encodeGlobalID("Actor", blocked.actor.id),
          viewerBlocks: true,
          blocksViewer: false,
        },
        b: {
          id: encodeGlobalID("Actor", blocker.actor.id),
          viewerBlocks: false,
          blocksViewer: true,
        },
        c: {
          id: encodeGlobalID("Actor", stranger.actor.id),
          viewerBlocks: false,
          blocksViewer: false,
        },
      });
    });
  },
});

// GraphQL spec: top-level mutation fields execute serially.  With
// `cache: false` on the loader, the second read sees the post-unblock
// state.  If someone removes `cache: false` (default DataLoader cache
// is `true`), the second `viewerBlocks` would return the cached `true`
// from the first read and this test would fail.
//
// All four follow/block loaders are selected on the mutation payload
// to smoke-test their plumbing.  Of the four, only `viewerBlocks`
// actually flips between the two reads in this scenario; the others
// stay at `false` because the viewer can't flip them in a single
// authenticated mutation document.  A companion follow/unfollow test
// below locks `cache: false` in for `viewerFollows`.
const blockUnblockMutation = parse(`
  mutation BlockThenUnblock($actorId: ID!) {
    block: blockActor(input: { actorId: $actorId }) {
      __typename
      ... on BlockActorPayload {
        blockee {
          id
          viewerBlocks
          blocksViewer
          viewerFollows
          followsViewer
        }
      }
    }
    unblock: unblockActor(input: { actorId: $actorId }) {
      __typename
      ... on UnblockActorPayload {
        blockee {
          id
          viewerBlocks
          blocksViewer
          viewerFollows
          followsViewer
        }
      }
    }
  }
`);

Deno.test({
  name:
    "Actor.viewerBlocks loader does not cache stale state across serial mutations",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const blocker = await insertAccountWithActor(tx, {
        username: "vbcacheblocker",
        name: "VB Cache Blocker",
        email: "vbcacheblocker@example.com",
      });
      const blockee = await insertAccountWithActor(tx, {
        username: "vbcacheblockee",
        name: "VB Cache Blockee",
        email: "vbcacheblockee@example.com",
      });

      const actorId = encodeGlobalID("Actor", blockee.actor.id);
      const result = await execute({
        schema,
        document: blockUnblockMutation,
        variableValues: { actorId },
        contextValue: makeUserContext(tx, blocker.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      const data = result.data as {
        block: {
          __typename: string;
          blockee?: {
            id: string;
            viewerBlocks: boolean;
            blocksViewer: boolean;
            viewerFollows: boolean;
            followsViewer: boolean;
          };
        };
        unblock: {
          __typename: string;
          blockee?: {
            id: string;
            viewerBlocks: boolean;
            blocksViewer: boolean;
            viewerFollows: boolean;
            followsViewer: boolean;
          };
        };
      };

      assertEquals(data.block.__typename, "BlockActorPayload");
      assertEquals(data.unblock.__typename, "UnblockActorPayload");

      // Crucial: this asserts the `viewerBlocks` loader re-queried after
      // the unblock mutation flipped state.  A `cache: true` regression
      // on `viewerBlocks` would surface here as the stale cached `true`.
      assertEquals(data.block.blockee?.viewerBlocks, true);
      assertEquals(data.unblock.blockee?.viewerBlocks, false);

      // Smoke-test the other three loaders on the mutation payload.
      // Their values don't flip between the two reads in this scenario,
      // so cache: true vs cache: false isn't differentiated here — but
      // a regression that breaks the field plumbing or returns
      // undefined/null would surface.
      assertEquals(data.block.blockee?.blocksViewer, false);
      assertEquals(data.unblock.blockee?.blocksViewer, false);
      assertEquals(data.block.blockee?.viewerFollows, false);
      assertEquals(data.unblock.blockee?.viewerFollows, false);
      assertEquals(data.block.blockee?.followsViewer, false);
      assertEquals(data.unblock.blockee?.followsViewer, false);
    });
  },
});

// Companion test that genuinely locks `cache: false` in for
// `viewerFollows`.  followActor creates the follow row and unfollowActor
// removes it, so the loader's value flips between the two payload reads.
const followUnfollowMutation = parse(`
  mutation FollowThenUnfollow($actorId: ID!) {
    follow: followActor(input: { actorId: $actorId }) {
      __typename
      ... on FollowActorPayload {
        followee { id viewerFollows }
      }
    }
    unfollow: unfollowActor(input: { actorId: $actorId }) {
      __typename
      ... on UnfollowActorPayload {
        followee { id viewerFollows }
      }
    }
  }
`);

Deno.test({
  name:
    "Actor.viewerFollows loader does not cache stale state across serial mutations",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const follower = await insertAccountWithActor(tx, {
        username: "vfcachefollower",
        name: "VF Cache Follower",
        email: "vfcachefollower@example.com",
      });
      const followee = await insertAccountWithActor(tx, {
        username: "vfcachefollowee",
        name: "VF Cache Followee",
        email: "vfcachefollowee@example.com",
      });

      const actorId = encodeGlobalID("Actor", followee.actor.id);
      const result = await execute({
        schema,
        document: followUnfollowMutation,
        variableValues: { actorId },
        contextValue: makeUserContext(tx, follower.account),
        onError: "NO_PROPAGATE",
      });

      assertEquals(result.errors, undefined);
      const data = result.data as {
        follow: {
          __typename: string;
          followee?: { id: string; viewerFollows: boolean };
        };
        unfollow: {
          __typename: string;
          followee?: { id: string; viewerFollows: boolean };
        };
      };

      assertEquals(data.follow.__typename, "FollowActorPayload");
      assertEquals(data.unfollow.__typename, "UnfollowActorPayload");
      assertEquals(data.follow.followee?.viewerFollows, true);
      // A `cache: true` regression on `viewerFollows` would surface
      // here as a stale cached `true`.
      assertEquals(data.unfollow.followee?.viewerFollows, false);
    });
  },
});
