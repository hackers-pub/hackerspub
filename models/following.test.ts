import assert from "node:assert";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  acceptFollowing,
  follow,
  getFollowedActorIds,
  getFollowerActorIds,
  unfollow,
} from "./following.ts";
import { actorTable, followingTable, notificationTable } from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  seedLocalInstance,
  withRollback,
} from "../test/postgres.ts";

test("follow() auto-accepts local follows and creates a notification", async () => {
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

    assert.ok(created != null);
    assert.ok(created.accepted != null);

    const stored = await tx.query.followingTable.findFirst({
      where: {
        followerId: follower.actor.id,
        followeeId: followee.actor.id,
      },
    });
    assert.ok(stored != null);
    assert.ok(stored.accepted != null);

    const followerActor = await tx.query.actorTable.findFirst({
      where: { id: follower.actor.id },
    });
    const followeeActor = await tx.query.actorTable.findFirst({
      where: { id: followee.actor.id },
    });
    assert.ok(followerActor != null);
    assert.ok(followeeActor != null);
    assert.deepEqual(followerActor.followeesCount, 1);
    assert.deepEqual(followeeActor.followersCount, 1);

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: followee.account.id,
        type: "follow",
      },
    });
    assert.ok(notification != null);
    assert.deepEqual(notification.actorIds, [follower.actor.id]);
  });
});

test("acceptFollowing() updates counts for pending remote follows", async () => {
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
    assert.ok(remoteActor != null);

    const pending = await follow(fedCtx, follower.account, remoteActor);

    assert.ok(pending != null);
    assert.deepEqual(pending.accepted, null);

    const followerBefore = await tx.query.actorTable.findFirst({
      where: { id: follower.actor.id },
    });
    const remoteBefore = await tx.query.actorTable.findFirst({
      where: { id: remoteActor.id },
    });
    assert.ok(followerBefore != null);
    assert.ok(remoteBefore != null);
    assert.deepEqual(followerBefore.followeesCount, 0);
    assert.deepEqual(remoteBefore.followersCount, 0);

    const accepted = await acceptFollowing(tx, follower.account, remoteActor);

    assert.ok(accepted != null);
    assert.ok(accepted.accepted != null);

    const followerAfter = await tx.query.actorTable.findFirst({
      where: { id: follower.actor.id },
    });
    const remoteAfter = await tx.query.actorTable.findFirst({
      where: { id: remoteActor.id },
    });
    assert.ok(followerAfter != null);
    assert.ok(remoteAfter != null);
    assert.deepEqual(followerAfter.followeesCount, 1);
    assert.deepEqual(remoteAfter.followersCount, 1);
  });
});

test("unfollow() removes local follow state and notification", async () => {
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

    assert.ok(removed != null);

    const stored = await tx.query.followingTable.findFirst({
      where: {
        followerId: follower.actor.id,
        followeeId: followee.actor.id,
      },
    });
    assert.deepEqual(stored, undefined);

    const followerActor = await tx.query.actorTable.findFirst({
      where: { id: follower.actor.id },
    });
    const followeeActor = await tx.query.actorTable.findFirst({
      where: { id: followee.actor.id },
    });
    assert.ok(followerActor != null);
    assert.ok(followeeActor != null);
    assert.deepEqual(followerActor.followeesCount, 0);
    assert.deepEqual(followeeActor.followersCount, 0);

    const notifications = await tx.select().from(notificationTable).where(eq(
      notificationTable.accountId,
      followee.account.id,
    ));
    assert.deepEqual(notifications, []);

    const followings = await tx.select().from(followingTable).where(eq(
      followingTable.followeeId,
      followee.actor.id,
    ));
    assert.deepEqual(followings, []);
  });
});

test("getFollowedActorIds returns the subset that the follower follows", async () => {
  await withRollback(async (tx) => {
    await seedLocalInstance(tx);
    const fedCtx = createFedCtx(tx);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const viewer = await insertAccountWithActor(tx, {
      username: `gfaiviewer${suffix}`,
      name: "GFAI Viewer",
      email: `gfaiviewer-${suffix}@example.com`,
    });
    const followed = await insertAccountWithActor(tx, {
      username: `gfaifollowed${suffix}`,
      name: "GFAI Followed",
      email: `gfaifollowed-${suffix}@example.com`,
    });
    const notFollowed = await insertAccountWithActor(tx, {
      username: `gfainotfollowed${suffix}`,
      name: "GFAI Not Followed",
      email: `gfainotfollowed-${suffix}@example.com`,
    });

    await follow(fedCtx, viewer.account, followed.actor);

    const result = await getFollowedActorIds(tx, viewer.actor.id, [
      followed.actor.id,
      notFollowed.actor.id,
      generateUuidV7() as Uuid,
    ]);

    assert.deepEqual(result.has(followed.actor.id), true);
    assert.deepEqual(result.has(notFollowed.actor.id), false);
    assert.deepEqual(result.size, 1);
  });
});

test("getFollowedActorIds returns empty for empty input", async () => {
  await withRollback(async (tx) => {
    const result = await getFollowedActorIds(
      tx,
      generateUuidV7() as Uuid,
      [],
    );
    assert.deepEqual(result.size, 0);
  });
});

test("getFollowerActorIds returns the subset that follows the followee", async () => {
  await withRollback(async (tx) => {
    await seedLocalInstance(tx);
    const fedCtx = createFedCtx(tx);
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    const target = await insertAccountWithActor(tx, {
      username: `gfraitarget${suffix}`,
      name: "GFRAI Target",
      email: `gfraitarget-${suffix}@example.com`,
    });
    const fan = await insertAccountWithActor(tx, {
      username: `gfraifan${suffix}`,
      name: "GFRAI Fan",
      email: `gfraifan-${suffix}@example.com`,
    });
    const stranger = await insertAccountWithActor(tx, {
      username: `gfraistranger${suffix}`,
      name: "GFRAI Stranger",
      email: `gfraistranger-${suffix}@example.com`,
    });

    await follow(fedCtx, fan.account, target.actor);

    const result = await getFollowerActorIds(tx, target.actor.id, [
      fan.actor.id,
      stranger.actor.id,
      generateUuidV7() as Uuid,
    ]);

    assert.deepEqual(result.has(fan.actor.id), true);
    assert.deepEqual(result.has(stranger.actor.id), false);
    assert.deepEqual(result.size, 1);
  });
});

test("getFollowerActorIds returns empty for empty input", async () => {
  await withRollback(async (tx) => {
    const result = await getFollowerActorIds(
      tx,
      generateUuidV7() as Uuid,
      [],
    );
    assert.deepEqual(result.size, 0);
  });
});
