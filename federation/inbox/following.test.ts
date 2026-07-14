import assert from "node:assert";
import { describe, it } from "node:test";
import type { InboxContext } from "@fedify/fedify";
import { Block } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import { followingTable } from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../../test/postgres.ts";
import {
  type FollowAcceptanceRepository,
  type FollowRejectionRepository,
  onBlocked,
  type PendingOutgoingFollowRepository,
  reconcileFollowAcceptance,
  reconcileFollowAcceptanceFromObjectId,
  reconcileFollowRejection,
  reconcileFollowRejectionFromObjectId,
} from "./following.ts";

const FOLLOWER_ACTOR_ID = "00000000-0000-0000-0000-000000000001" as Uuid;
const FOLLOWEE_ACTOR_ID = "00000000-0000-0000-0000-000000000002" as Uuid;

describe("onBlocked()", () => {
  it("rolls back the block when relationship cleanup cannot be enqueued", async () => {
    await withRollback(async (tx) => {
      let deliveryFails = true;
      const baseFedCtx = createFedCtx(tx);
      const fedCtx = {
        ...baseFedCtx,
        sendActivity() {
          return deliveryFails
            ? Promise.reject(new Error("outbox persistence failed"))
            : Promise.resolve(undefined);
        },
      } as typeof baseFedCtx;
      const local = await insertAccountWithActor(tx, {
        username: "blockedlocal",
        name: "Blocked Local",
        email: "blockedlocal@example.com",
      });
      const remote = await insertRemoteActor(tx, {
        username: "blockingremote",
        name: "Blocking Remote",
        host: "blocking.example",
      });
      const followIri =
        `https://blocking.example/follows/${crypto.randomUUID()}`;
      await tx.insert(followingTable).values({
        iri: followIri,
        followerId: remote.id,
        followeeId: local.actor.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
      const block = new Block({
        id: new URL(
          `https://blocking.example/blocks/${crypto.randomUUID()}`,
        ),
        actor: new URL(remote.iri),
        object: new URL(local.actor.iri),
      });
      const inboxContext = fedCtx as unknown as InboxContext<ContextData>;

      await assert.rejects(
        () => onBlocked(inboxContext, block),
        /outbox persistence failed/,
      );

      const failedBlock = await tx.query.blockingTable.findFirst({
        where: { iri: block.id!.href },
      });
      const retainedFollow = await tx.query.followingTable.findFirst({
        where: {
          followerId: remote.id,
          followeeId: local.actor.id,
        },
      });
      assert.equal(failedBlock, undefined);
      assert.ok(retainedFollow != null);

      deliveryFails = false;
      await onBlocked(inboxContext, block);

      const persistedBlock = await tx.query.blockingTable.findFirst({
        where: { iri: block.id!.href },
      });
      const removedFollow = await tx.query.followingTable.findFirst({
        where: {
          followerId: remote.id,
          followeeId: local.actor.id,
        },
      });
      assert.ok(persistedBlock != null);
      assert.equal(removedFollow, undefined);
    });
  });
});

describe("reconcileFollowAcceptance()", () => {
  it(
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
      assert.deepEqual(accepted, true);
      assert.deepEqual(calls, { byIri: 1, byActorIds: 0 });
    },
  );

  it(
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
      assert.deepEqual(accepted, true);
      assert.deepEqual(calls, { byIri: 1, byActorIds: 1 });
    },
  );
});

describe("reconcileFollowRejection()", () => {
  it(
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
      assert.deepEqual(rejected, true);
      assert.deepEqual(calls, { byIri: 1, byActorIds: 0 });
    },
  );

  it(
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
      assert.deepEqual(rejected, true);
      assert.deepEqual(calls, { byIri: 1, byActorIds: 1 });
    },
  );
});

describe("reconcileFollowAcceptanceFromObjectId()", () => {
  it(
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
      assert.deepEqual(accepted, true);
      assert.deepEqual(calls, { findPending: 1, byIri: 1, byActorIds: 0 });
    },
  );

  it(
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
      assert.deepEqual(accepted, false);
      assert.deepEqual(calls, { findPending: 1, byIri: 0, byActorIds: 0 });
    },
  );
});

describe("reconcileFollowRejectionFromObjectId()", () => {
  it(
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
      assert.deepEqual(rejected, true);
      assert.deepEqual(calls, { findPending: 1, byIri: 1, byActorIds: 0 });
    },
  );

  it(
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
      assert.deepEqual(rejected, false);
      assert.deepEqual(calls, { findPending: 1, byIri: 0, byActorIds: 0 });
    },
  );
});
