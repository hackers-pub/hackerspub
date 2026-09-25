import assert from "node:assert";
import test from "node:test";
import {
  createFollowingIri,
  follow,
  removeFollower,
  unfollow,
  updateFolloweesCount,
  updateFollowersCount,
} from "./following.ts";
import { createFollowNotification } from "./notification.ts";
import { followingTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

test("createFollowingIri() builds a local follow IRI under the actor URI", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const follower = await insertAccountWithActor(tx, {
      username: "followiriowner",
      name: "Follow IRI Owner",
      email: "followiriowner@example.com",
    });

    const iri = createFollowingIri(fedCtx, follower.account);

    assert.equal(iri.origin, "http://localhost");
    assert.match(
      iri.href,
      new RegExp(`/actors/${follower.account.id}#follow/`),
    );
  });
});

test("follow() and unfollow() send federation activities for remote actors", async () => {
  await withRollback(async (tx) => {
    const sent: unknown[] = [];
    const baseFedCtx = createFedCtx(tx);
    const fedCtx = {
      ...baseFedCtx,
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as typeof baseFedCtx;
    const local = await insertAccountWithActor(tx, {
      username: "followremoteowner",
      name: "Follow Remote Owner",
      email: "followremoteowner@example.com",
    });
    const remote = await insertRemoteActor(tx, {
      username: "followremoteactor",
      name: "Follow Remote Actor",
      host: "remote.example",
    });

    const following = await follow(fedCtx, local.account, remote);

    assert.ok(following != null);
    assert.equal(following.accepted, null);
    assert.equal(sent.length, 1);

    const removed = await unfollow(fedCtx, local.account, remote);

    assert.ok(removed != null);
    assert.equal(sent.length, 2);
    const stored = await tx.query.followingTable.findFirst({
      where: {
        followerId: local.actor.id,
        followeeId: remote.id,
      },
    });
    assert.equal(stored, undefined);
    const storedLocal = await tx.query.actorTable.findFirst({
      where: { id: local.actor.id },
    });
    const storedRemote = await tx.query.actorTable.findFirst({
      where: { id: remote.id },
    });
    assert.equal(storedLocal?.followeesCount, 0);
    assert.equal(storedRemote?.followersCount, 0);
  });
});

test("removeFollower() sends a Reject activity for remote followers", async () => {
  await withRollback(async (tx) => {
    const sent: unknown[] = [];
    const baseFedCtx = createFedCtx(tx);
    const fedCtx = {
      ...baseFedCtx,
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as typeof baseFedCtx;
    const followee = await insertAccountWithActor(tx, {
      username: "removefollowerowner",
      name: "Remove Follower Owner",
      email: "removefollowerowner@example.com",
    });
    const remoteFollower = await insertRemoteActor(tx, {
      username: "remotefollower",
      name: "Remote Follower",
      host: "remote.example",
    });
    await tx.insert(followingTable).values({
      iri: `https://remote.example/follows/${remoteFollower.id}`,
      followerId: remoteFollower.id,
      followeeId: followee.actor.id,
      accepted: new Date("2026-04-15T00:00:00.000Z"),
    });

    const removed = await removeFollower(
      fedCtx,
      followee.account,
      remoteFollower,
    );

    assert.ok(removed != null);
    assert.equal(sent.length, 1);
    const remaining = await tx.query.followingTable.findFirst({
      where: {
        followerId: remoteFollower.id,
        followeeId: followee.actor.id,
      },
    });
    assert.equal(remaining, undefined);
  });
});

test("removeFollower() does not decrement counts for pending followers", async () => {
  await withRollback(async (tx) => {
    const sent: unknown[] = [];
    const baseFedCtx = createFedCtx(tx);
    const fedCtx = {
      ...baseFedCtx,
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as typeof baseFedCtx;
    const followee = await insertAccountWithActor(tx, {
      username: "removependingowner",
      name: "Remove Pending Owner",
      email: "removependingowner@example.com",
    });
    const remoteFollower = await insertRemoteActor(tx, {
      username: "removependingremote",
      name: "Remove Pending Remote",
      host: "remote.example",
    });
    await tx.insert(followingTable).values({
      iri: `https://remote.example/follows/${remoteFollower.id}/pending`,
      followerId: remoteFollower.id,
      followeeId: followee.actor.id,
      accepted: null,
    });
    await createFollowNotification(tx, followee.account.id, remoteFollower);

    const removed = await removeFollower(
      fedCtx,
      followee.account,
      remoteFollower,
    );

    assert.ok(removed != null);
    assert.equal(sent.length, 1);
    const remaining = await tx.query.followingTable.findFirst({
      where: {
        followerId: remoteFollower.id,
        followeeId: followee.actor.id,
      },
    });
    assert.equal(remaining, undefined);

    const storedFollower = await tx.query.actorTable.findFirst({
      where: { id: remoteFollower.id },
    });
    const storedFollowee = await tx.query.actorTable.findFirst({
      where: { id: followee.actor.id },
    });
    const storedNotification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: followee.account.id,
        type: "follow",
      },
    });
    assert.equal(storedFollower?.followeesCount, 0);
    assert.equal(storedFollowee?.followersCount, 0);
    assert.equal(storedNotification, undefined);
  });
});

test("unfollow() never pushes a remote actor's cached count below zero", async () => {
  await withRollback(async (tx) => {
    const baseFedCtx = createFedCtx(tx);
    const fedCtx = {
      ...baseFedCtx,
      sendActivity() {
        return Promise.resolve(undefined);
      },
    } as typeof baseFedCtx;
    const local = await insertAccountWithActor(tx, {
      username: "hiddenfollowsowner",
      name: "Hidden Follows Owner",
      email: "hiddenfollowsowner@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "hiddenfollowsother",
      name: "Hidden Follows Other",
      email: "hiddenfollowsother@example.com",
    });
    // The remote server hides its followers collection, so the cached count
    // is 0 even though two local accounts follow the actor:
    const remote = await insertRemoteActor(tx, {
      username: "hiddenfollowsremote",
      name: "Hidden Follows Remote",
      host: "hidden.example",
      followersCount: 0,
    });
    for (const account of [local, other]) {
      await tx.insert(followingTable).values({
        iri: createFollowingIri(fedCtx, account.account).href,
        followerId: account.actor.id,
        followeeId: remote.id,
        accepted: new Date("2026-09-14T00:00:00.000Z"),
      });
    }

    await unfollow(fedCtx, local.account, remote);

    // One accepted local follower is still known, which is a lower bound:
    let stored = await tx.query.actorTable.findFirst({
      where: { id: remote.id },
    });
    assert.equal(stored?.followersCount, 1);

    await unfollow(fedCtx, other.account, remote);

    stored = await tx.query.actorTable.findFirst({
      where: { id: remote.id },
    });
    assert.equal(stored?.followersCount, 0);
  });
});

test("removeFollower() never pushes a remote actor's cached count below zero", async () => {
  await withRollback(async (tx) => {
    const baseFedCtx = createFedCtx(tx);
    const fedCtx = {
      ...baseFedCtx,
      sendActivity() {
        return Promise.resolve(undefined);
      },
    } as typeof baseFedCtx;
    const local = await insertAccountWithActor(tx, {
      username: "hiddenfollowingowner",
      name: "Hidden Following Owner",
      email: "hiddenfollowingowner@example.com",
    });
    const remote = await insertRemoteActor(tx, {
      username: "hiddenfollowingremote",
      name: "Hidden Following Remote",
      host: "hidden.example",
      followeesCount: 0,
    });
    await tx.insert(followingTable).values({
      iri: `https://hidden.example/follows/${crypto.randomUUID()}`,
      followerId: remote.id,
      followeeId: local.actor.id,
      accepted: new Date("2026-09-14T00:00:00.000Z"),
    });

    await removeFollower(fedCtx, local.account, remote);

    const stored = await tx.query.actorTable.findFirst({
      where: { id: remote.id },
    });
    assert.equal(stored?.followeesCount, 0);
  });
});

test("updateFolloweesCount() floors a remote count at its known accepted followings", async () => {
  await withRollback(async (tx) => {
    const locals = [];
    for (const name of ["flooreda", "flooredb", "flooredc"]) {
      locals.push(
        await insertAccountWithActor(tx, {
          username: name,
          name,
          email: `${name}@example.com`,
        }),
      );
    }
    const remote = await insertRemoteActor(tx, {
      username: "flooredremote",
      name: "Floored Remote",
      host: "floored.example",
      followeesCount: 0,
    });
    // Two accepted followings and one pending one; only the accepted ones
    // count towards the floor:
    for (const [i, local] of locals.entries()) {
      await tx.insert(followingTable).values({
        iri: `https://floored.example/follows/${crypto.randomUUID()}`,
        followerId: remote.id,
        followeeId: local.actor.id,
        accepted: i < 2 ? new Date("2026-09-14T00:00:00.000Z") : null,
      });
    }

    const updated = await updateFolloweesCount(tx, remote.id, -1);

    assert.equal(updated?.followeesCount, 2);
  });
});

test("updateFolloweesCount() and updateFollowersCount() saturate at the integer limit", async () => {
  await withRollback(async (tx) => {
    const remote = await insertRemoteActor(tx, {
      username: "saturatedremote",
      name: "Saturated Remote",
      host: "saturated.example",
      followeesCount: 2147483647,
      followersCount: 2147483647,
    });

    const followees = await updateFolloweesCount(tx, remote.id, 1);
    const followers = await updateFollowersCount(tx, remote.id, 1);

    assert.equal(followees?.followeesCount, 2147483647);
    assert.equal(followers?.followersCount, 2147483647);
  });
});
