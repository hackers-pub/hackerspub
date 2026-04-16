import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { eq } from "drizzle-orm";
import { acceptFollowing, follow, unfollow } from "./following.ts";
import { actorTable, followingTable, notificationTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  seedLocalInstance,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name: "follow() auto-accepts local follows and creates a notification",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const follower = await insertAccountWithActor(tx, {
        username: `follower${suffix}`,
        name: "Follower",
        email: `follower-${suffix}@example.com`,
      });
      const followee = await insertAccountWithActor(tx, {
        username: `followee${suffix}`,
        name: "Followee",
        email: `followee-${suffix}@example.com`,
      });

      const created = await follow(fedCtx, follower.account, followee.actor);

      assert(created != null);
      assert(created.accepted != null);

      const stored = await tx.query.followingTable.findFirst({
        where: {
          followerId: follower.actor.id,
          followeeId: followee.actor.id,
        },
      });
      assert(stored != null);
      assert(stored.accepted != null);

      const followerActor = await tx.query.actorTable.findFirst({
        where: { id: follower.actor.id },
      });
      const followeeActor = await tx.query.actorTable.findFirst({
        where: { id: followee.actor.id },
      });
      assert(followerActor != null);
      assert(followeeActor != null);
      assertEquals(followerActor.followeesCount, 1);
      assertEquals(followeeActor.followersCount, 1);

      const notification = await tx.query.notificationTable.findFirst({
        where: {
          accountId: followee.account.id,
          type: "follow",
        },
      });
      assert(notification != null);
      assertEquals(notification.actorIds, [follower.actor.id]);
    });
  },
});

Deno.test({
  name: "acceptFollowing() updates counts for pending remote follows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const follower = await insertAccountWithActor(tx, {
        username: `pendingfollower${suffix}`,
        name: "Pending Follower",
        email: `pendingfollower-${suffix}@example.com`,
      });

      await seedLocalInstance(tx, "remote.example");
      const remoteActorId = generateUuidV7();
      await tx.insert(actorTable).values({
        id: remoteActorId,
        iri: "https://remote.example/users/remote",
        type: "Person",
        username: `remote${suffix}`,
        instanceHost: "remote.example",
        handleHost: "remote.example",
        name: "Remote",
        inboxUrl: "https://remote.example/users/remote/inbox",
        sharedInboxUrl: "https://remote.example/inbox",
      });
      const remoteActor = await tx.query.actorTable.findFirst({
        where: { id: remoteActorId },
      });
      assert(remoteActor != null);

      const pending = await follow(fedCtx, follower.account, remoteActor);

      assert(pending != null);
      assertEquals(pending.accepted, null);

      const followerBefore = await tx.query.actorTable.findFirst({
        where: { id: follower.actor.id },
      });
      const remoteBefore = await tx.query.actorTable.findFirst({
        where: { id: remoteActor.id },
      });
      assert(followerBefore != null);
      assert(remoteBefore != null);
      assertEquals(followerBefore.followeesCount, 0);
      assertEquals(remoteBefore.followersCount, 0);

      const accepted = await acceptFollowing(tx, follower.account, remoteActor);

      assert(accepted != null);
      assert(accepted.accepted != null);

      const followerAfter = await tx.query.actorTable.findFirst({
        where: { id: follower.actor.id },
      });
      const remoteAfter = await tx.query.actorTable.findFirst({
        where: { id: remoteActor.id },
      });
      assert(followerAfter != null);
      assert(remoteAfter != null);
      assertEquals(followerAfter.followeesCount, 1);
      assertEquals(remoteAfter.followersCount, 1);
    });
  },
});

Deno.test({
  name: "unfollow() removes local follow state and notification",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
      const follower = await insertAccountWithActor(tx, {
        username: `leaver${suffix}`,
        name: "Leaver",
        email: `leaver-${suffix}@example.com`,
      });
      const followee = await insertAccountWithActor(tx, {
        username: `target${suffix}`,
        name: "Target",
        email: `target-${suffix}@example.com`,
      });

      await follow(fedCtx, follower.account, followee.actor);

      const removed = await unfollow(fedCtx, follower.account, followee.actor);

      assert(removed != null);

      const stored = await tx.query.followingTable.findFirst({
        where: {
          followerId: follower.actor.id,
          followeeId: followee.actor.id,
        },
      });
      assertEquals(stored, undefined);

      const followerActor = await tx.query.actorTable.findFirst({
        where: { id: follower.actor.id },
      });
      const followeeActor = await tx.query.actorTable.findFirst({
        where: { id: followee.actor.id },
      });
      assert(followerActor != null);
      assert(followeeActor != null);
      assertEquals(followerActor.followeesCount, 0);
      assertEquals(followeeActor.followersCount, 0);

      const notifications = await tx.select().from(notificationTable).where(eq(
        notificationTable.accountId,
        followee.account.id,
      ));
      assertEquals(notifications, []);

      const followings = await tx.select().from(followingTable).where(eq(
        followingTable.followeeId,
        followee.actor.id,
      ));
      assertEquals(followings, []);
    });
  },
});
