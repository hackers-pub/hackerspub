import { assertEquals } from "@std/assert/equals";
import type { Uuid } from "@hackerspub/models/uuid";
import {
  type FollowAcceptanceRepository,
  type FollowRejectionRepository,
  reconcileFollowAcceptance,
  reconcileFollowRejection,
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
