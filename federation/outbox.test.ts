import { assertEquals } from "@std/assert/equals";
import type { Actor, Following } from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import {
  handlePermanentFailure,
  type PermanentFailureRepository,
  type PermanentFailureValues,
} from "./outbox.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeActor(
  overrides: Partial<Actor> & { id: Uuid; iri: string },
): Actor {
  return {
    type: "Person",
    username: "test",
    instanceHost: "remote.example",
    handleHost: "remote.example",
    handle: `@test@remote.example`,
    accountId: null, // remote by default
    name: null,
    bioHtml: null,
    automaticallyApprovesFollowers: false,
    avatarUrl: null,
    headerUrl: null,
    inboxUrl: "https://remote.example/inbox",
    sharedInboxUrl: null,
    followersUrl: null,
    featuredUrl: null,
    fieldHtmls: {},
    emojis: {},
    tags: {},
    sensitive: false,
    successorId: null,
    aliases: [],
    followeesCount: 0,
    followersCount: 0,
    postsCount: 0,
    url: null,
    updated: new Date(),
    published: null,
    created: new Date(),
    ...overrides,
  };
}

function makeFollowing(
  overrides: Partial<Following> & {
    followerId: Uuid;
    followeeId: Uuid;
  },
): Following {
  return {
    iri: `https://example.com/follow/${crypto.randomUUID()}`,
    accepted: new Date(),
    created: new Date(),
    ...overrides,
  };
}

interface CallLog {
  deleteFollowingsByFollowerIds: Uuid[][];
  deleteFollowingsByFolloweeIds: Uuid[][];
  updateFollowersCount: Array<{ followeeId: Uuid; delta: number }>;
  updateFolloweesCount: Array<{ followerId: Uuid; delta: number }>;
  deleteActors: Uuid[][];
}

function createMockRepo(
  actors: Actor[],
  followingsAsFollower: Following[],
  followingsAsFollowee: Following[],
): { repo: PermanentFailureRepository; calls: CallLog } {
  const calls: CallLog = {
    deleteFollowingsByFollowerIds: [],
    deleteFollowingsByFolloweeIds: [],
    updateFollowersCount: [],
    updateFolloweesCount: [],
    deleteActors: [],
  };

  const repo: PermanentFailureRepository = {
    findActorsByIris(iris) {
      return Promise.resolve(
        actors.filter((a) => iris.includes(a.iri)),
      );
    },
    deleteFollowingsByFollowerIds(followerIds) {
      calls.deleteFollowingsByFollowerIds.push([...followerIds]);
      return Promise.resolve(
        followingsAsFollower.filter((f) => followerIds.includes(f.followerId)),
      );
    },
    deleteFollowingsByFolloweeIds(followeeIds) {
      calls.deleteFollowingsByFolloweeIds.push([...followeeIds]);
      return Promise.resolve(
        followingsAsFollowee.filter((f) => followeeIds.includes(f.followeeId)),
      );
    },
    updateFollowersCount(followeeId, delta) {
      calls.updateFollowersCount.push({ followeeId, delta });
      return Promise.resolve();
    },
    updateFolloweesCount(followerId, delta) {
      calls.updateFolloweesCount.push({ followerId, delta });
      return Promise.resolve();
    },
    deleteActors(actorIds) {
      calls.deleteActors.push([...actorIds]);
      return Promise.resolve();
    },
  };

  return { repo, calls };
}

// ---------------------------------------------------------------------------
// Shared IDs
// ---------------------------------------------------------------------------

const REMOTE_ACTOR_ID = "00000000-0000-0000-0000-000000000001" as Uuid;
const LOCAL_FOLLOWEE_ID = "00000000-0000-0000-0000-000000000002" as Uuid;
const LOCAL_FOLLOWER_ID = "00000000-0000-0000-0000-000000000003" as Uuid;
const LOCAL_ACTOR_ID = "00000000-0000-0000-0000-000000000004" as Uuid;
const REMOTE_ACTOR_2_ID = "00000000-0000-0000-0000-000000000005" as Uuid;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("handlePermanentFailure()", async (t) => {
  await t.step("does nothing when actorIds is empty", async () => {
    const { repo, calls } = createMockRepo([], [], []);
    const values: PermanentFailureValues = {
      inbox: new URL("https://remote.example/inbox"),
      statusCode: 404,
      actorIds: [],
    };
    await handlePermanentFailure(repo, values);
    assertEquals(calls.deleteFollowingsByFollowerIds.length, 0);
    assertEquals(calls.deleteFollowingsByFolloweeIds.length, 0);
    assertEquals(calls.deleteActors.length, 0);
  });

  await t.step(
    "does nothing when actor IRI is not found in DB",
    async () => {
      const { repo, calls } = createMockRepo([], [], []);
      const values: PermanentFailureValues = {
        inbox: new URL("https://remote.example/inbox"),
        statusCode: 404,
        actorIds: [new URL("https://remote.example/users/ghost")],
      };
      await handlePermanentFailure(repo, values);
      assertEquals(calls.deleteFollowingsByFollowerIds.length, 0);
      assertEquals(calls.deleteFollowingsByFolloweeIds.length, 0);
      assertEquals(calls.deleteActors.length, 0);
    },
  );

  await t.step("skips local actors (accountId is not null)", async () => {
    const localActor = makeActor({
      id: LOCAL_ACTOR_ID,
      iri: "https://hackers.pub/users/alice",
      accountId: "00000000-0000-0000-0000-aaaaaaaaaaaa" as Uuid,
    });
    const { repo, calls } = createMockRepo([localActor], [], []);
    const values: PermanentFailureValues = {
      inbox: new URL("https://hackers.pub/inbox"),
      statusCode: 410,
      actorIds: [new URL("https://hackers.pub/users/alice")],
    };
    await handlePermanentFailure(repo, values);
    assertEquals(calls.deleteFollowingsByFollowerIds.length, 0);
    assertEquals(calls.deleteFollowingsByFolloweeIds.length, 0);
    assertEquals(calls.deleteActors.length, 0);
  });

  await t.step(
    "on 404: deletes followings but does NOT delete actor record",
    async () => {
      const remoteActor = makeActor({
        id: REMOTE_ACTOR_ID,
        iri: "https://remote.example/users/bob",
      });
      const followingAsFollower = makeFollowing({
        followerId: REMOTE_ACTOR_ID,
        followeeId: LOCAL_FOLLOWEE_ID,
      });
      const followingAsFollowee = makeFollowing({
        followerId: LOCAL_FOLLOWER_ID,
        followeeId: REMOTE_ACTOR_ID,
      });

      const { repo, calls } = createMockRepo(
        [remoteActor],
        [followingAsFollower],
        [followingAsFollowee],
      );
      const values: PermanentFailureValues = {
        inbox: new URL("https://remote.example/inbox"),
        statusCode: 404,
        actorIds: [new URL("https://remote.example/users/bob")],
      };
      await handlePermanentFailure(repo, values);

      // Following relationships deleted:
      assertEquals(calls.deleteFollowingsByFollowerIds, [[REMOTE_ACTOR_ID]]);
      assertEquals(calls.deleteFollowingsByFolloweeIds, [[REMOTE_ACTOR_ID]]);

      // Counts updated:
      assertEquals(calls.updateFollowersCount, [
        { followeeId: LOCAL_FOLLOWEE_ID, delta: -1 },
      ]);
      assertEquals(calls.updateFolloweesCount, [
        { followerId: LOCAL_FOLLOWER_ID, delta: -1 },
      ]);

      // Actor record NOT deleted on 404:
      assertEquals(calls.deleteActors.length, 0);
    },
  );

  await t.step(
    "on 410: deletes followings AND deletes actor record",
    async () => {
      const remoteActor = makeActor({
        id: REMOTE_ACTOR_ID,
        iri: "https://remote.example/users/bob",
      });
      const followingAsFollower = makeFollowing({
        followerId: REMOTE_ACTOR_ID,
        followeeId: LOCAL_FOLLOWEE_ID,
      });

      const { repo, calls } = createMockRepo(
        [remoteActor],
        [followingAsFollower],
        [],
      );
      const values: PermanentFailureValues = {
        inbox: new URL("https://remote.example/inbox"),
        statusCode: 410,
        actorIds: [new URL("https://remote.example/users/bob")],
      };
      await handlePermanentFailure(repo, values);

      // Following relationships deleted:
      assertEquals(calls.deleteFollowingsByFollowerIds, [[REMOTE_ACTOR_ID]]);
      assertEquals(calls.deleteFollowingsByFolloweeIds, [[REMOTE_ACTOR_ID]]);

      // Counts updated for the follower relationship only:
      assertEquals(calls.updateFollowersCount, [
        { followeeId: LOCAL_FOLLOWEE_ID, delta: -1 },
      ]);
      assertEquals(calls.updateFolloweesCount, []);

      // Actor record IS deleted on 410:
      assertEquals(calls.deleteActors, [[REMOTE_ACTOR_ID]]);
    },
  );

  await t.step("handles multiple remote actors at once", async () => {
    const actor1 = makeActor({
      id: REMOTE_ACTOR_ID,
      iri: "https://remote.example/users/bob",
    });
    const actor2 = makeActor({
      id: REMOTE_ACTOR_2_ID,
      iri: "https://another.example/users/carol",
      instanceHost: "another.example",
      handleHost: "another.example",
    });
    const f1 = makeFollowing({
      followerId: REMOTE_ACTOR_ID,
      followeeId: LOCAL_FOLLOWEE_ID,
    });
    const f2 = makeFollowing({
      followerId: REMOTE_ACTOR_2_ID,
      followeeId: LOCAL_FOLLOWEE_ID,
    });

    const { repo, calls } = createMockRepo(
      [actor1, actor2],
      [f1, f2],
      [],
    );
    const values: PermanentFailureValues = {
      inbox: new URL("https://remote.example/inbox"),
      statusCode: 410,
      actorIds: [
        new URL("https://remote.example/users/bob"),
        new URL("https://another.example/users/carol"),
      ],
    };
    await handlePermanentFailure(repo, values);

    assertEquals(calls.deleteFollowingsByFollowerIds, [
      [REMOTE_ACTOR_ID, REMOTE_ACTOR_2_ID],
    ]);
    assertEquals(calls.deleteFollowingsByFolloweeIds, [
      [REMOTE_ACTOR_ID, REMOTE_ACTOR_2_ID],
    ]);
    // Both followers pointed to the same local followee:
    assertEquals(calls.updateFollowersCount, [
      { followeeId: LOCAL_FOLLOWEE_ID, delta: -1 },
      { followeeId: LOCAL_FOLLOWEE_ID, delta: -1 },
    ]);
    assertEquals(calls.deleteActors, [
      [REMOTE_ACTOR_ID, REMOTE_ACTOR_2_ID],
    ]);
  });

  await t.step(
    "filters out local actors when mixed with remote actors",
    async () => {
      const remoteActor = makeActor({
        id: REMOTE_ACTOR_ID,
        iri: "https://remote.example/users/bob",
      });
      const localActor = makeActor({
        id: LOCAL_ACTOR_ID,
        iri: "https://hackers.pub/users/alice",
        accountId: "00000000-0000-0000-0000-aaaaaaaaaaaa" as Uuid,
      });
      const f1 = makeFollowing({
        followerId: REMOTE_ACTOR_ID,
        followeeId: LOCAL_FOLLOWEE_ID,
      });

      const { repo, calls } = createMockRepo(
        [remoteActor, localActor],
        [f1],
        [],
      );
      const values: PermanentFailureValues = {
        inbox: new URL("https://remote.example/inbox"),
        statusCode: 404,
        actorIds: [
          new URL("https://remote.example/users/bob"),
          new URL("https://hackers.pub/users/alice"),
        ],
      };
      await handlePermanentFailure(repo, values);

      // Only remote actor processed:
      assertEquals(calls.deleteFollowingsByFollowerIds, [[REMOTE_ACTOR_ID]]);
      assertEquals(calls.deleteFollowingsByFolloweeIds, [[REMOTE_ACTOR_ID]]);
      assertEquals(calls.updateFollowersCount, [
        { followeeId: LOCAL_FOLLOWEE_ID, delta: -1 },
      ]);
      // No actor deletion on 404:
      assertEquals(calls.deleteActors.length, 0);
    },
  );

  await t.step(
    "no following relationships to delete still completes without error",
    async () => {
      const remoteActor = makeActor({
        id: REMOTE_ACTOR_ID,
        iri: "https://remote.example/users/bob",
      });

      const { repo, calls } = createMockRepo([remoteActor], [], []);
      const values: PermanentFailureValues = {
        inbox: new URL("https://remote.example/inbox"),
        statusCode: 404,
        actorIds: [new URL("https://remote.example/users/bob")],
      };
      await handlePermanentFailure(repo, values);

      // Delete was called but returned nothing:
      assertEquals(calls.deleteFollowingsByFollowerIds, [[REMOTE_ACTOR_ID]]);
      assertEquals(calls.deleteFollowingsByFolloweeIds, [[REMOTE_ACTOR_ID]]);
      // No counts to update:
      assertEquals(calls.updateFollowersCount, []);
      assertEquals(calls.updateFolloweesCount, []);
      // No actor deletion on 404:
      assertEquals(calls.deleteActors.length, 0);
    },
  );
});
