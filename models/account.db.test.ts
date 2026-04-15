import assert from "node:assert/strict";
import test from "node:test";
import {
  getAccountByUsername,
  getRelationship,
  updateAccountData,
} from "./account.ts";
import { block } from "./blocking.ts";
import { follow } from "./following.ts";
import { followingTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

test("getAccountByUsername() resolves current and previous usernames", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "lookupaccount",
      name: "Lookup Account",
      email: "lookupaccount@example.com",
    });

    const updated = await updateAccountData(tx, {
      id: account.account.id,
      username: "renamedaccount",
      name: "Renamed Account",
    });

    assert.ok(updated != null);
    assert.equal(updated.username, "renamedaccount");
    assert.equal(updated.oldUsername, "lookupaccount");
    assert.ok(updated.usernameChanged != null);

    const current = await getAccountByUsername(tx, "renamedaccount");
    const previous = await getAccountByUsername(tx, "lookupaccount");

    assert.ok(current != null);
    assert.ok(previous != null);
    assert.equal(current.id, account.account.id);
    assert.equal(previous.id, account.account.id);
    assert.equal(previous.username, "renamedaccount");
    assert.equal(previous.actor.id, account.actor.id);
    assert.deepEqual(
      previous.emails.map((email) => email.email),
      ["lookupaccount@example.com"],
    );
  });
});

test("getRelationship() reports follow, request, and block states", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const viewer = await insertAccountWithActor(tx, {
      username: "vieweraccount",
      name: "Viewer Account",
      email: "vieweraccount@example.com",
    });
    const localTarget = await insertAccountWithActor(tx, {
      username: "localtarget",
      name: "Local Target",
      email: "localtarget@example.com",
    });
    const blocker = await insertAccountWithActor(tx, {
      username: "blockeraccount",
      name: "Blocker Account",
      email: "blockeraccount@example.com",
    });
    const remoteTarget = await insertRemoteActor(tx, {
      username: "remotetarget",
      name: "Remote Target",
      host: "remote.example",
    });
    const remoteFollower = await insertRemoteActor(tx, {
      username: "remotefollower",
      name: "Remote Follower",
      host: "followers.example",
    });

    assert.equal(await getRelationship(tx, null, localTarget.actor), null);
    assert.equal(await getRelationship(tx, viewer.account, viewer.actor), null);

    const none = await getRelationship(tx, viewer.account, localTarget.actor);
    assert.deepEqual(
      none == null ? null : {
        outgoing: none.outgoing,
        incoming: none.incoming,
      },
      { outgoing: "none", incoming: "none" },
    );

    await follow(fedCtx, viewer.account, localTarget.actor);
    await follow(fedCtx, localTarget.account, viewer.actor);

    const mutualFollow = await getRelationship(
      tx,
      viewer.account,
      localTarget.actor,
    );
    assert.deepEqual(
      mutualFollow == null ? null : {
        outgoing: mutualFollow.outgoing,
        incoming: mutualFollow.incoming,
      },
      { outgoing: "follow", incoming: "follow" },
    );

    await follow(fedCtx, viewer.account, remoteTarget);

    const outgoingRequest = await getRelationship(
      tx,
      viewer.account,
      remoteTarget,
    );
    assert.deepEqual(
      outgoingRequest == null ? null : {
        outgoing: outgoingRequest.outgoing,
        incoming: outgoingRequest.incoming,
      },
      { outgoing: "request", incoming: "none" },
    );

    await tx.insert(followingTable).values({
      iri: "https://followers.example/follows/remotefollower",
      followerId: remoteFollower.id,
      followeeId: viewer.actor.id,
    });

    const incomingRequest = await getRelationship(
      tx,
      viewer.account,
      remoteFollower,
    );
    assert.deepEqual(
      incomingRequest == null ? null : {
        outgoing: incomingRequest.outgoing,
        incoming: incomingRequest.incoming,
      },
      { outgoing: "none", incoming: "request" },
    );

    await block(fedCtx, blocker.account, viewer.actor);

    const incomingBlock = await getRelationship(
      tx,
      viewer.account,
      blocker.actor,
    );
    assert.deepEqual(
      incomingBlock == null ? null : {
        outgoing: incomingBlock.outgoing,
        incoming: incomingBlock.incoming,
      },
      { outgoing: "none", incoming: "block" },
    );
  });
});
