import assert from "node:assert/strict";
import test from "node:test";
import * as vocab from "@fedify/vocab";
import { block, persistBlocking, unblock } from "./blocking.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

test("block() and unblock() send federation activities for remote actors", async () => {
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
    const blocker = await insertAccountWithActor(tx, {
      username: "blockremoteowner",
      name: "Block Remote Owner",
      email: "blockremoteowner@example.com",
    });
    const remote = await insertRemoteActor(tx, {
      username: "blockremoteactor",
      name: "Block Remote Actor",
      host: "remote.example",
    });

    const created = await block(fedCtx, blocker.account, remote);

    assert.ok(created != null);
    assert.equal(sent.length, 1);

    const removed = await unblock(fedCtx, blocker.account, remote);

    assert.ok(removed != null);
    assert.equal(sent.length, 2);
    const stored = await tx.query.blockingTable.findFirst({
      where: { blockerId: blocker.actor.id, blockeeId: remote.id },
    });
    assert.equal(stored, undefined);
  });
});

test("persistBlocking() stores a remote block activity between remote actors", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const blocker = await insertRemoteActor(tx, {
      username: "persistblocker",
      name: "Persist Blocker",
      host: "blocker.example",
      iri: "https://blocker.example/users/blocker",
    });
    const blockee = await insertRemoteActor(tx, {
      username: "persistblockee",
      name: "Persist Blockee",
      host: "blockee.example",
      iri: "https://blockee.example/users/blockee",
    });

    const activity = new vocab.Block({
      id: new URL("https://blocker.example/activities/block-1"),
      actor: new URL(blocker.iri),
      object: new URL(blockee.iri),
    });

    await persistBlocking(fedCtx, activity);

    const duplicate = await persistBlocking(fedCtx, activity);
    assert.equal(duplicate, undefined);

    const rows = await tx.query.blockingTable.findMany({
      where: { blockerId: blocker.id, blockeeId: blockee.id },
    });
    assert.equal(rows.length, 1);
  });
});
