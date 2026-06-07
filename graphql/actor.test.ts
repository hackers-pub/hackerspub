import assert from "node:assert";
import test from "node:test";
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
  toPlainJson,
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

const removeFollowerSchemaQuery = parse(`
  query RemoveFollowerSchema {
    __schema {
      mutationType {
        fields {
          name
          description
        }
      }
    }
    removeFollowerInput: __type(name: "RemoveFollowerInput") {
      inputFields {
        name
        description
      }
    }
    removeFollowerPayload: __type(name: "RemoveFollowerPayload") {
      fields {
        name
        description
      }
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

test("followActor rejects attempts to follow yourself", async () => {
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

    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as {
        followActor: { __typename: string; inputPath?: string };
      }).followActor,
      {
        __typename: "InvalidInputError",
        inputPath: "actorId",
      },
    );
  });
});

test("followActor and unfollowActor round-trip through GraphQL", async () => {
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

    assert.deepEqual(followResult.errors, undefined);
    assert.deepEqual(
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
    assert.deepEqual(storedAfterFollow?.accepted != null, true);

    const unfollowResult = await execute({
      schema,
      document: unfollowActorMutation,
      variableValues: { actorId },
      contextValue: makeUserContext(tx, follower.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(unfollowResult.errors, undefined);
    assert.deepEqual(
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
    assert.deepEqual(storedAfterUnfollow, undefined);
  });
});

test("removeFollower removes an existing follower relation", async () => {
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

    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(
      (result.data as {
        removeFollower: { __typename: string };
      }).removeFollower.__typename,
      "RemoveFollowerPayload",
    );

    const stored = await tx.select().from(followingTable).where(and(
      eq(followingTable.followerId, follower.actor.id),
      eq(followingTable.followeeId, followee.actor.id),
    ));
    assert.deepEqual(stored, []);
  });
});

test("removeFollower rejects guests and self-removal", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "graphqlremoveself",
      name: "GraphQL Remove Self",
      email: "graphqlremoveself@example.com",
    });
    const actorId = encodeGlobalID("Actor", account.actor.id);

    const guestResult = await execute({
      schema,
      document: removeFollowerMutation,
      variableValues: { actorId },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(guestResult.errors, undefined);
    assert.deepEqual(toPlainJson(guestResult.data), {
      removeFollower: {
        __typename: "NotAuthenticatedError",
        notAuthenticated: "",
      },
    });

    const selfResult = await execute({
      schema,
      document: removeFollowerMutation,
      variableValues: { actorId },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(selfResult.errors, undefined);
    assert.deepEqual(toPlainJson(selfResult.data), {
      removeFollower: {
        __typename: "InvalidInputError",
        inputPath: "actorId",
      },
    });
  });
});

test("removeFollower is documented in the GraphQL schema", async () => {
  const result = await execute({
    schema,
    document: removeFollowerSchemaQuery,
    onError: "NO_PROPAGATE",
  });

  assert.deepEqual(result.errors, undefined);
  const data = toPlainJson(result.data) as {
    __schema: {
      mutationType: {
        fields: { name: string; description: string | null }[];
      };
    };
    removeFollowerInput: {
      inputFields: { name: string; description: string | null }[];
    };
    removeFollowerPayload: {
      fields: { name: string; description: string | null }[];
    };
  };
  const mutation = data.__schema.mutationType.fields.find((field) =>
    field.name === "removeFollower"
  );
  assert.match(mutation?.description ?? "", /authenticated viewer/);

  const actorId = data.removeFollowerInput.inputFields.find((field) =>
    field.name === "actorId"
  );
  assert.match(actorId?.description ?? "", /follower/);

  const follower = data.removeFollowerPayload.fields.find((field) =>
    field.name === "follower"
  );
  assert.match(follower?.description ?? "", /removed follower/);

  const followee = data.removeFollowerPayload.fields.find((field) =>
    field.name === "followee"
  );
  assert.match(followee?.description ?? "", /authenticated viewer/);
});

test("blockActor and unblockActor round-trip through GraphQL", async () => {
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
    assert.deepEqual(storedBeforeBlock.length, 2);

    const blockResult = await execute({
      schema,
      document: blockActorMutation,
      variableValues: { actorId },
      contextValue: makeUserContext(tx, blocker.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(blockResult.errors, undefined);
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
    assert.deepEqual(blockActorPayload.__typename, "BlockActorPayload");
    assert.deepEqual(
      blockActorPayload.blockee,
      expectedBlockeePayload(true),
    );

    const storedAfterBlock = await tx.select().from(blockingTable).where(and(
      eq(blockingTable.blockerId, blocker.actor.id),
      eq(blockingTable.blockeeId, blockee.actor.id),
    ));
    assert.deepEqual(storedAfterBlock.length, 1);
    assert.deepEqual(storedAfterBlock[0].blockeeId, blockee.actor.id);

    const unblockResult = await execute({
      schema,
      document: unblockActorMutation,
      variableValues: { actorId },
      contextValue: makeUserContext(tx, blocker.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(unblockResult.errors, undefined);
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
    assert.deepEqual(unblockActorPayload.__typename, "UnblockActorPayload");
    assert.deepEqual(
      unblockActorPayload.blockee,
      expectedBlockeePayload(false),
    );

    const storedAfterUnblock = await tx.select().from(blockingTable).where(
      and(
        eq(blockingTable.blockerId, blocker.actor.id),
        eq(blockingTable.blockeeId, blockee.actor.id),
      ),
    );
    assert.deepEqual(storedAfterUnblock, []);
  });
});

test("Actor block fields expose outgoing and incoming viewer block state", async () => {
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

    assert.deepEqual(beforeBlock.errors, undefined);
    assert.deepEqual(beforeBlock.data, {
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

    assert.deepEqual(blockResult.errors, undefined);
    assert.deepEqual(
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

    assert.deepEqual(guestAfterBlock.errors, undefined);
    assert.deepEqual(guestAfterBlock.data, {
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

    assert.deepEqual(outgoingState.errors, undefined);
    assert.deepEqual(outgoingState.data, {
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

    assert.deepEqual(incomingState.errors, undefined);
    assert.deepEqual(incomingState.data, {
      actorByUuid: {
        id: encodeGlobalID("Actor", blocker.actor.id),
        viewerBlocks: false,
        blocksViewer: true,
      },
    });
  });
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

const followersOrderQuery = parse(`
  query FollowersOrder($uuid: UUID!) {
    actorByUuid(uuid: $uuid) {
      followers(first: 10) {
        totalCount
        edges { accepted node { username } }
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

test("Actor.viewerFollows returns the right state per actor when batched", async () => {
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

    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(result.data, {
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
});

test(
  "Actor.mutualFollowers returns followers the viewer also follows, and is " +
    "empty for guests and for the viewer's own profile",
  async () => {
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
      assert.deepEqual(viewerResult.errors, undefined);
      assert.deepEqual(viewerResult.data, {
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
      assert.deepEqual(guestResult.errors, undefined);
      assert.deepEqual(guestResult.data, {
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
      assert.deepEqual(ownResult.errors, undefined);
      assert.deepEqual(ownResult.data, {
        actorByUuid: {
          mutualFollowers: { totalCount: 0, edges: [] },
        },
      });
    });
  },
);

test("Actor.followers lists mutual followers (followers you know) first", async () => {
  await withRollback(async (tx) => {
    const viewer = await insertAccountWithActor(tx, {
      username: "foviewer",
      name: "FO Viewer",
      email: "foviewer@example.com",
    });
    const profile = await insertAccountWithActor(tx, {
      username: "foprofile",
      name: "FO Profile",
      email: "foprofile@example.com",
    });
    const mutualA = await insertAccountWithActor(tx, {
      username: "fomutuala",
      name: "FO Mutual A",
      email: "fomutuala@example.com",
    });
    const mutualB = await insertAccountWithActor(tx, {
      username: "fomutualb",
      name: "FO Mutual B",
      email: "fomutualb@example.com",
    });
    const plainC = await insertAccountWithActor(tx, {
      username: "foplainc",
      name: "FO Plain C",
      email: "foplainc@example.com",
    });
    const plainD = await insertAccountWithActor(tx, {
      username: "foplaind",
      name: "FO Plain D",
      email: "foplaind@example.com",
    });

    const fedCtx = createFedCtx(tx);
    // All four follow the profile.
    await follow(fedCtx, mutualA.account, profile.actor);
    await follow(fedCtx, mutualB.account, profile.actor);
    await follow(fedCtx, plainC.account, profile.actor);
    await follow(fedCtx, plainD.account, profile.actor);
    // The viewer follows only the two "mutual" followers.
    await follow(fedCtx, viewer.account, mutualA.actor);
    await follow(fedCtx, viewer.account, mutualB.actor);

    const result = await execute({
      schema,
      document: followersOrderQuery,
      variableValues: { uuid: profile.actor.id },
      contextValue: makeUserContext(tx, viewer.account),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(result.errors, undefined);
    const conn = (result.data as {
      actorByUuid: {
        followers: {
          totalCount: number;
          edges: { accepted: string | null; node: { username: string } }[];
        };
      };
    }).actorByUuid.followers;

    assert.deepEqual(conn.totalCount, 4);
    const usernames = conn.edges.map((edge) => edge.node.username);
    assert.deepEqual(usernames.length, 4);
    // The two mutual followers come first (order within the group is not
    // asserted), then the two the viewer does not follow.
    assert.deepEqual(
      new Set(usernames.slice(0, 2)),
      new Set(["fomutuala", "fomutualb"]),
    );
    assert.deepEqual(
      new Set(usernames.slice(2)),
      new Set(["foplainc", "foplaind"]),
    );
    // The follow-row edge fields still resolve after the custom re-shaping.
    assert.deepEqual(conn.edges.every((edge) => edge.accepted != null), true);

    // A guest takes the no-viewer ordering branch: it must run without error
    // and still return every accepted follower.
    const guestResult = await execute({
      schema,
      document: followersOrderQuery,
      variableValues: { uuid: profile.actor.id },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(guestResult.errors, undefined);
    const guestConn = (guestResult.data as {
      actorByUuid: {
        followers: {
          totalCount: number;
          edges: { node: { username: string } }[];
        };
      };
    }).actorByUuid.followers;
    assert.deepEqual(guestConn.totalCount, 4);
    assert.deepEqual(
      new Set(guestConn.edges.map((edge) => edge.node.username)),
      new Set(["fomutuala", "fomutualb", "foplainc", "foplaind"]),
    );
  });
});

test("Actor.viewerFollows returns false for a guest viewer", async () => {
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

    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      a: { viewerFollows: boolean };
      b: { viewerFollows: boolean };
      c: { viewerFollows: boolean };
    };
    assert.deepEqual(data.a.viewerFollows, false);
    assert.deepEqual(data.b.viewerFollows, false);
    assert.deepEqual(data.c.viewerFollows, false);
  });
});

test(
  "Actor.viewerFollows and followsViewer are batched into independent results",
  async () => {
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

      assert.deepEqual(result.errors, undefined);
      assert.deepEqual(result.data, {
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
);

test("Actor.viewerBlocks returns the right state per actor when batched", async () => {
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

    assert.deepEqual(result.errors, undefined);
    assert.deepEqual(result.data, {
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
});

test("Actor.viewerBlocks returns false for a guest viewer", async () => {
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

    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      a: { viewerBlocks: boolean };
      b: { viewerBlocks: boolean };
      c: { viewerBlocks: boolean };
    };
    assert.deepEqual(data.a.viewerBlocks, false);
    assert.deepEqual(data.b.viewerBlocks, false);
    assert.deepEqual(data.c.viewerBlocks, false);
  });
});

test(
  "Actor.viewerBlocks and blocksViewer are batched into independent results",
  async () => {
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

      assert.deepEqual(result.errors, undefined);
      assert.deepEqual(result.data, {
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
);

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

test(
  "Actor.viewerBlocks loader does not cache stale state across serial mutations",
  async () => {
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

      assert.deepEqual(result.errors, undefined);
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

      assert.deepEqual(data.block.__typename, "BlockActorPayload");
      assert.deepEqual(data.unblock.__typename, "UnblockActorPayload");

      // Crucial: this asserts the `viewerBlocks` loader re-queried after
      // the unblock mutation flipped state.  A `cache: true` regression
      // on `viewerBlocks` would surface here as the stale cached `true`.
      assert.deepEqual(data.block.blockee?.viewerBlocks, true);
      assert.deepEqual(data.unblock.blockee?.viewerBlocks, false);

      // Smoke-test the other three loaders on the mutation payload.
      // Their values don't flip between the two reads in this scenario,
      // so cache: true vs cache: false isn't differentiated here — but
      // a regression that breaks the field plumbing or returns
      // undefined/null would surface.
      assert.deepEqual(data.block.blockee?.blocksViewer, false);
      assert.deepEqual(data.unblock.blockee?.blocksViewer, false);
      assert.deepEqual(data.block.blockee?.viewerFollows, false);
      assert.deepEqual(data.unblock.blockee?.viewerFollows, false);
      assert.deepEqual(data.block.blockee?.followsViewer, false);
      assert.deepEqual(data.unblock.blockee?.followsViewer, false);
    });
  },
);

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

test(
  "Actor.viewerFollows loader does not cache stale state across serial mutations",
  async () => {
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

      assert.deepEqual(result.errors, undefined);
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

      assert.deepEqual(data.follow.__typename, "FollowActorPayload");
      assert.deepEqual(data.unfollow.__typename, "UnfollowActorPayload");
      assert.deepEqual(data.follow.followee?.viewerFollows, true);
      // A `cache: true` regression on `viewerFollows` would surface
      // here as a stale cached `true`.
      assert.deepEqual(data.unfollow.followee?.viewerFollows, false);
    });
  },
);
