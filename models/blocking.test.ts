import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { and, eq } from "drizzle-orm";
import { block, unblock } from "./blocking.ts";
import { follow } from "./following.ts";
import { blockingTable, followingTable } from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name: "block() removes local follow relationships in both directions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const blocker = await insertAccountWithActor(tx, {
        username: "blocker",
        name: "Blocker",
        email: "blocker@example.com",
      });
      const blockee = await insertAccountWithActor(tx, {
        username: "blockee",
        name: "Blockee",
        email: "blockee@example.com",
      });

      await follow(fedCtx, blocker.account, blockee.actor);
      await follow(fedCtx, blockee.account, blocker.actor);

      const created = await block(fedCtx, blocker.account, blockee.actor);

      assert(created != null);

      const blocking = await tx.query.blockingTable.findFirst({
        where: {
          blockerId: blocker.actor.id,
          blockeeId: blockee.actor.id,
        },
      });
      assert(blocking != null);

      const followRows = await tx.select().from(followingTable).where(
        and(
          eq(followingTable.followerId, blocker.actor.id),
          eq(followingTable.followeeId, blockee.actor.id),
        ),
      );
      assertEquals(followRows, []);

      const reverseFollowRows = await tx.select().from(followingTable).where(
        and(
          eq(followingTable.followerId, blockee.actor.id),
          eq(followingTable.followeeId, blocker.actor.id),
        ),
      );
      assertEquals(reverseFollowRows, []);
    });
  },
});

Deno.test({
  name: "unblock() deletes the blocking row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const blocker = await insertAccountWithActor(tx, {
        username: "unblocker",
        name: "Unblocker",
        email: "unblocker@example.com",
      });
      const blockee = await insertAccountWithActor(tx, {
        username: "unblockee",
        name: "Unblockee",
        email: "unblockee@example.com",
      });

      await block(fedCtx, blocker.account, blockee.actor);

      const removed = await unblock(fedCtx, blocker.account, blockee.actor);

      assert(removed != null);

      const remaining = await tx.select().from(blockingTable).where(
        and(
          eq(blockingTable.blockerId, blocker.actor.id),
          eq(blockingTable.blockeeId, blockee.actor.id),
        ),
      );
      assertEquals(remaining, []);
    });
  },
});

Deno.test({
  name:
    "block() removes follow relationships with remote blockees in both directions",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const fedCtx = createFedCtx(tx);
      const blocker = await insertAccountWithActor(tx, {
        username: "remoteblocker",
        name: "Remote Blocker",
        email: "remoteblocker@example.com",
      });
      const remoteBlockee = await insertRemoteActor(tx, {
        username: `remote-blockee-${
          crypto.randomUUID().replaceAll("-", "").slice(0, 8)
        }`,
        name: "Remote Blockee",
        host: "remote.example",
      });

      await follow(fedCtx, blocker.account, remoteBlockee);
      await tx.insert(followingTable).values({
        iri: `https://remote.example/follows/${crypto.randomUUID()}`,
        followerId: remoteBlockee.id,
        followeeId: blocker.actor.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });

      const created = await block(fedCtx, blocker.account, remoteBlockee);

      assert(created != null);

      const forwardFollow = await tx.select().from(followingTable).where(
        and(
          eq(followingTable.followerId, blocker.actor.id),
          eq(followingTable.followeeId, remoteBlockee.id),
        ),
      );
      assertEquals(forwardFollow, []);

      const reverseFollow = await tx.select().from(followingTable).where(
        and(
          eq(followingTable.followerId, remoteBlockee.id),
          eq(followingTable.followeeId, blocker.actor.id),
        ),
      );
      assertEquals(reverseFollow, []);
    });
  },
});
