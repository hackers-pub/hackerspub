import assert from "node:assert";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { db as testDb } from "../test/database.ts";
import { withRollback } from "../test/postgres.ts";
import {
  claimOutboxEvent,
  completeOutboxEvent,
  enqueueOutboxEvents,
  failOutboxEvent,
  pruneOutboxEvents,
  replayOutboxEvent,
  retryOutboxEvent,
} from "./outbox.ts";
import { outboxEventTable } from "./schema.ts";

const delivery = (messageId: string) => ({
  eventType: "activitypub.delivery" as const,
  messageId,
  payloadVersion: 1,
  payload: { type: "outbox", id: messageId },
  activityId: `https://example.com/activities/${messageId}`,
  activityType: "Create",
  inbox: "https://remote.example/inbox",
});

test("outbox enqueue follows transaction commit and rollback", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);

    await tx.transaction(async (committed) => {
      await enqueueOutboxEvents(committed, [delivery("committed")]);
    });

    await assert.rejects(
      tx.transaction(async (rolledBack) => {
        await enqueueOutboxEvents(rolledBack, [delivery("rolled-back")]);
        throw new Error("roll back");
      }),
      /roll back/,
    );

    const rows = await tx.select({ messageId: outboxEventTable.messageId })
      .from(outboxEventTable);
    assert.deepEqual(rows, [{ messageId: "committed" }]);
  });
});

test("outbox claims one ordered event at a time across workers", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const now = new Date("2026-07-14T00:00:00.000Z");
    await enqueueOutboxEvents(
      tx,
      [delivery("first"), delivery("second")],
      { orderingKey: "actor:alice", now },
    );

    const first = await claimOutboxEvent(tx, "activitypub.delivery", {
      now,
      leaseDuration: { seconds: 180 },
    });
    assert.equal(first?.messageId, "first");

    const blocked = await claimOutboxEvent(tx, "activitypub.delivery", {
      now,
      leaseDuration: { seconds: 180 },
    });
    assert.equal(blocked, null);

    assert(first != null);
    assert.equal(await completeOutboxEvent(tx, first), true);

    const second = await claimOutboxEvent(tx, "activitypub.delivery", {
      now,
      leaseDuration: { seconds: 180 },
    });
    assert.equal(second?.messageId, "second");
  });
});

test("outbox does not claim a lower event while the same key is processing", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const now = new Date("2026-07-14T00:00:00.000Z");
    await enqueueOutboxEvents(
      tx,
      [delivery("lower"), delivery("higher")],
      { orderingKey: "actor:commit-race", now },
    );
    await tx.update(outboxEventTable).set({
      status: "processing",
      leaseToken: crypto.randomUUID(),
      leased: now,
    }).where(eq(outboxEventTable.messageId, "higher"));

    const claimed = await claimOutboxEvent(tx, "activitypub.delivery", {
      now,
      leaseDuration: { seconds: 180 },
    });

    assert.equal(claimed, null);
  });
});

test("same-key enqueue transactions serialize before either can commit", async () => {
  const suffix = crypto.randomUUID();
  const firstId = `first-${suffix}`;
  const secondId = `second-${suffix}`;
  const orderingKey = `actor:${suffix}`;
  const firstInserted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let firstTransaction = Promise.resolve();
  let secondTransaction = Promise.resolve();
  try {
    firstTransaction = testDb.transaction(async (tx) => {
      await enqueueOutboxEvents(tx, [delivery(firstId)], { orderingKey });
      firstInserted.resolve();
      await releaseFirst.promise;
    });
    await firstInserted.promise;

    let secondInserted = false;
    secondTransaction = testDb.transaction(async (tx) => {
      await enqueueOutboxEvents(tx, [delivery(secondId)], { orderingKey });
      secondInserted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondInserted, false);

    releaseFirst.resolve();
    await Promise.all([firstTransaction, secondTransaction]);
    const first = await claimOutboxEvent(testDb, "activitypub.delivery", {
      leaseDuration: { seconds: 180 },
    });
    assert.equal(first?.messageId, firstId);
  } finally {
    releaseFirst.resolve();
    await Promise.allSettled([firstTransaction, secondTransaction]);
    await testDb.delete(outboxEventTable).where(
      eq(outboxEventTable.orderingKey, orderingKey),
    );
  }
});

test("expired leases are reclaimed and stale workers cannot acknowledge", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const started = new Date("2026-07-14T00:00:00.000Z");
    await enqueueOutboxEvents(tx, [delivery("crashed")], { now: started });

    const crashed = await claimOutboxEvent(tx, "activitypub.delivery", {
      now: started,
      leaseDuration: { seconds: 180 },
    });
    assert(crashed != null);

    const recovered = await claimOutboxEvent(tx, "activitypub.delivery", {
      now: new Date("2026-07-14T00:03:01.000Z"),
      leaseDuration: { seconds: 180 },
    });
    assert(recovered != null);
    assert.equal(recovered.id, crashed.id);
    assert.notEqual(recovered.leaseToken, crashed.leaseToken);
    assert.equal(await completeOutboxEvent(tx, crashed), false);
    assert.equal(await completeOutboxEvent(tx, recovered), true);
  });
});

test("Fedify retries reuse the leased row and terminal failures can replay", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const now = new Date("2026-07-14T00:00:00.000Z");
    await enqueueOutboxEvents(tx, [delivery("retry")], { now });

    const first = await claimOutboxEvent(tx, "activitypub.delivery", {
      now,
      leaseDuration: { seconds: 180 },
    });
    assert(first != null);
    const retryAvailable = new Date("2026-07-14T00:05:00.000Z");
    assert.equal(
      await retryOutboxEvent(tx, first, {
        payload: { type: "outbox", id: "retry", attempt: 1 },
        available: retryAvailable,
        error: { name: "Error", message: "temporary" },
      }),
      true,
    );

    assert.equal(
      await claimOutboxEvent(tx, "activitypub.delivery", {
        now: new Date("2026-07-14T00:04:59.000Z"),
        leaseDuration: { seconds: 180 },
      }),
      null,
    );
    const retried = await claimOutboxEvent(tx, "activitypub.delivery", {
      now: retryAvailable,
      leaseDuration: { seconds: 180 },
    });
    assert(retried != null);
    assert.equal(retried.id, first.id);
    assert.equal(retried.processingAttempts, 2);

    assert.equal(
      await failOutboxEvent(tx, retried, {
        name: "Error",
        message: "permanent",
      }),
      true,
    );
    assert.equal(await replayOutboxEvent(tx, retried.id, now), true);

    const replayed = await claimOutboxEvent(tx, "activitypub.delivery", {
      now,
      leaseDuration: { seconds: 180 },
    });
    assert.equal(replayed?.id, first.id);
  });
});

test("completed outbox rows redact sensitive payloads", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const now = new Date("2026-07-14T00:00:00.000Z");
    await enqueueOutboxEvents(tx, [delivery("redacted")], { now });
    const event = await claimOutboxEvent(tx, "activitypub.delivery", {
      now,
      leaseDuration: { seconds: 180 },
    });
    assert(event != null);
    await completeOutboxEvent(tx, event, now);

    const [row] = await tx.select().from(outboxEventTable)
      .where(sql`${outboxEventTable.id} = ${event.id}`);
    assert.equal(row.status, "completed");
    assert.equal(row.payload, null);
    assert.equal(row.completed?.toISOString(), now.toISOString());
  });
});

test("outbox pruning keeps recent diagnostics and removes expired rows", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const old = new Date("2026-06-01T00:00:00.000Z");
    const recent = new Date("2026-07-13T12:00:00.000Z");
    for (
      const messageId of [
        "old-completed",
        "recent-completed",
        "old-dead",
        "recent-dead",
      ]
    ) {
      await enqueueOutboxEvents(tx, [delivery(messageId)], { now: old });
      const event = await claimOutboxEvent(tx, "activitypub.delivery", {
        now: old,
        leaseDuration: { seconds: 180 },
      });
      assert(event != null);
      if (messageId.endsWith("completed")) {
        await completeOutboxEvent(
          tx,
          event,
          messageId.startsWith("old") ? old : recent,
        );
      } else {
        await failOutboxEvent(
          tx,
          event,
          { name: "Error", message: messageId },
          messageId.startsWith("old") ? old : recent,
        );
      }
    }

    assert.equal(
      await pruneOutboxEvents(tx, {
        completedBefore: new Date("2026-07-13T00:00:00.000Z"),
        failedBefore: new Date("2026-07-01T00:00:00.000Z"),
      }),
      2,
    );
    const rows = await tx.select({ messageId: outboxEventTable.messageId })
      .from(outboxEventTable);
    assert.deepEqual(
      rows.map(({ messageId }) => messageId).sort(),
      ["recent-completed", "recent-dead"],
    );
  });
});
