import assert from "node:assert/strict";
import test from "node:test";
import {
  createFollowingIri,
  follow,
  removeFollower,
  unfollow,
} from "./following.ts";
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
