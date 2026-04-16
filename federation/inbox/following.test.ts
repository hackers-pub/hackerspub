import { assertEquals } from "@std/assert/equals";
import type { Uuid } from "@hackerspub/models/uuid";
import {
  type FollowAcceptanceRepository,
  type FollowRejectionRepository,
  type PendingOutgoingFollowRepository,
  reconcileFollowAcceptance,
  reconcileFollowAcceptanceFromObjectId,
  reconcileFollowRejection,
  reconcileFollowRejectionFromObjectId,
} from "./following.ts";

const FOLLOWER_ACTOR_ID = "00000000-0000-0000-0000-000000000001" as Uuid;
const FOLLOWEE_ACTOR_ID = "00000000-0000-0000-0000-000000000002" as Uuid;

Deno.test("reconcileFollowAcceptance()", async (t) => {
  await t.step(
    "uses IRI path first and skips fallback when it succeeds",
    async () => {
      const calls = { byIri: 0, byActorIds: 0 };
      const repo: FollowAcceptanceRepository = {
        async acceptByIri() {
          calls.byIri++;
          return true;
        },
        async acceptByActorIds() {
          calls.byActorIds++;
          return true;
        },
      };
      const accepted = await reconcileFollowAcceptance(
        repo,
        {
          followIri: "https://remote.example/follow/123",
          followerActorId: FOLLOWER_ACTOR_ID,
          followeeActorId: FOLLOWEE_ACTOR_ID,
        },
      );
      assertEquals(accepted, true);
      assertEquals(calls, { byIri: 1, byActorIds: 0 });
    },
  );

  await t.step(
    "falls back to actor IDs when IRI path does not match",
    async () => {
      const calls = { byIri: 0, byActorIds: 0 };
      const repo: FollowAcceptanceRepository = {
        async acceptByIri() {
          calls.byIri++;
          return false;
        },
        async acceptByActorIds() {
          calls.byActorIds++;
          return true;
        },
      };
      const accepted = await reconcileFollowAcceptance(
        repo,
        {
          followIri: "https://remote.example/follow/does-not-match-local",
          followerActorId: FOLLOWER_ACTOR_ID,
          followeeActorId: FOLLOWEE_ACTOR_ID,
        },
      );
      assertEquals(accepted, true);
      assertEquals(calls, { byIri: 1, byActorIds: 1 });
    },
  );
});

Deno.test("reconcileFollowRejection()", async (t) => {
  await t.step(
    "uses IRI path first and skips fallback when it succeeds",
    async () => {
      const calls = { byIri: 0, byActorIds: 0 };
      const repo: FollowRejectionRepository = {
        async rejectByIri() {
          calls.byIri++;
          return true;
        },
        async rejectByActorIds() {
          calls.byActorIds++;
          return true;
        },
      };
      const rejected = await reconcileFollowRejection(
        repo,
        {
          followIri: "https://remote.example/follow/123",
          followerActorId: FOLLOWER_ACTOR_ID,
          followeeActorId: FOLLOWEE_ACTOR_ID,
        },
      );
      assertEquals(rejected, true);
      assertEquals(calls, { byIri: 1, byActorIds: 0 });
    },
  );

  await t.step(
    "falls back to actor IDs when IRI path does not match",
    async () => {
      const calls = { byIri: 0, byActorIds: 0 };
      const repo: FollowRejectionRepository = {
        async rejectByIri() {
          calls.byIri++;
          return false;
        },
        async rejectByActorIds() {
          calls.byActorIds++;
          return true;
        },
      };
      const rejected = await reconcileFollowRejection(
        repo,
        {
          followIri: "https://remote.example/follow/does-not-match-local",
          followerActorId: FOLLOWER_ACTOR_ID,
          followeeActorId: FOLLOWEE_ACTOR_ID,
        },
      );
      assertEquals(rejected, true);
      assertEquals(calls, { byIri: 1, byActorIds: 1 });
    },
  );
});

Deno.test("reconcileFollowAcceptanceFromObjectId()", async (t) => {
  await t.step(
    "accepts a pending outgoing follow using object IRI metadata",
    async () => {
      const calls = { findPending: 0, byIri: 0, byActorIds: 0 };
      const repo: FollowAcceptanceRepository & PendingOutgoingFollowRepository =
        {
          async findPendingOutgoingByIri() {
            calls.findPending++;
            return {
              followIri: "https://hackers.pub/ap/actors/local#follow/1",
              followerActorId: FOLLOWER_ACTOR_ID,
              followeeActorId: FOLLOWEE_ACTOR_ID,
            };
          },
          async acceptByIri() {
            calls.byIri++;
            return true;
          },
          async acceptByActorIds() {
            calls.byActorIds++;
            return true;
          },
        };
      const accepted = await reconcileFollowAcceptanceFromObjectId(
        repo,
        {
          followIri: "https://hackers.pub/ap/actors/local#follow/1",
          followeeIri: "https://remote.example/users/followee",
        },
      );
      assertEquals(accepted, true);
      assertEquals(calls, { findPending: 1, byIri: 1, byActorIds: 0 });
    },
  );

  await t.step(
    "ignores unmatched object IRIs",
    async () => {
      const calls = { findPending: 0, byIri: 0, byActorIds: 0 };
      const repo: FollowAcceptanceRepository & PendingOutgoingFollowRepository =
        {
          async findPendingOutgoingByIri() {
            calls.findPending++;
            return undefined;
          },
          async acceptByIri() {
            calls.byIri++;
            return true;
          },
          async acceptByActorIds() {
            calls.byActorIds++;
            return true;
          },
        };
      const accepted = await reconcileFollowAcceptanceFromObjectId(
        repo,
        {
          followIri: "https://hackers.pub/ap/actors/local#follow/missing",
          followeeIri: "https://remote.example/users/followee",
        },
      );
      assertEquals(accepted, false);
      assertEquals(calls, { findPending: 1, byIri: 0, byActorIds: 0 });
    },
  );
});

Deno.test("reconcileFollowRejectionFromObjectId()", async (t) => {
  await t.step(
    "rejects a pending outgoing follow using object IRI metadata",
    async () => {
      const calls = { findPending: 0, byIri: 0, byActorIds: 0 };
      const repo: FollowRejectionRepository & PendingOutgoingFollowRepository =
        {
          async findPendingOutgoingByIri() {
            calls.findPending++;
            return {
              followIri: "https://hackers.pub/ap/actors/local#follow/1",
              followerActorId: FOLLOWER_ACTOR_ID,
              followeeActorId: FOLLOWEE_ACTOR_ID,
            };
          },
          async rejectByIri() {
            calls.byIri++;
            return true;
          },
          async rejectByActorIds() {
            calls.byActorIds++;
            return true;
          },
        };
      const rejected = await reconcileFollowRejectionFromObjectId(
        repo,
        {
          followIri: "https://hackers.pub/ap/actors/local#follow/1",
          followeeIri: "https://remote.example/users/followee",
        },
      );
      assertEquals(rejected, true);
      assertEquals(calls, { findPending: 1, byIri: 1, byActorIds: 0 });
    },
  );

  await t.step(
    "ignores unmatched reject object IRIs",
    async () => {
      const calls = { findPending: 0, byIri: 0, byActorIds: 0 };
      const repo: FollowRejectionRepository & PendingOutgoingFollowRepository =
        {
          async findPendingOutgoingByIri() {
            calls.findPending++;
            return undefined;
          },
          async rejectByIri() {
            calls.byIri++;
            return true;
          },
          async rejectByActorIds() {
            calls.byActorIds++;
            return true;
          },
        };
      const rejected = await reconcileFollowRejectionFromObjectId(
        repo,
        {
          followIri: "https://hackers.pub/ap/actors/local#follow/missing",
          followeeIri: "https://remote.example/users/followee",
        },
      );
      assertEquals(rejected, false);
      assertEquals(calls, { findPending: 1, byIri: 0, byActorIds: 0 });
    },
  );
});
