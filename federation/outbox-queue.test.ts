import assert from "node:assert";
import test from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { db as testDb } from "../test/database.ts";
import { withRollback } from "../test/postgres.ts";
import { outboxEventTable } from "@hackerspub/models/schema";
import {
  getCurrentOutboxDatabase,
  recordOutboxDeliveryError,
  runWithOutboxContext,
  TransactionalOutboxQueue,
} from "./outbox-queue.ts";

const now = new Date("2026-07-14T00:00:00.000Z");

function message(id: string, attempt = 0) {
  return {
    type: "outbox",
    id,
    activityId: `https://example.com/activities/${id}`,
    activityType: "Create",
    inbox: "https://remote.example/inbox",
    attempt,
  };
}

test("transactional queue enqueues batches with delay and reports depth", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const queue = new TransactionalOutboxQueue(tx, "activitypub.delivery", {
      now: () => now,
    });

    await runWithOutboxContext(tx, async () => {
      await queue.enqueueMany?.([message("one"), message("two")], {
        delay: Temporal.Duration.from({ minutes: 5 }),
      });
    });

    assert.deepEqual(await queue.getDepth?.(), {
      queued: 2,
      ready: 0,
      delayed: 2,
    });
    const rows = await tx.select().from(outboxEventTable);
    assert.deepEqual(
      rows.map((row) => row.messageId),
      ["one", "two"],
    );
    assert(rows.every((row) => row.payloadVersion === 1));
  });
});

test("nested parallel enqueues receive distinct ordering positions", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const fanoutQueue = new TransactionalOutboxQueue(tx, "activitypub.fanout", {
      now: () => now,
      pollInterval: { milliseconds: 1 },
    });
    const deliveryQueue = new TransactionalOutboxQueue(
      tx,
      "activitypub.delivery",
      { now: () => now },
    );
    await fanoutQueue.enqueue({ type: "fanout", id: "parent" });

    const controller = new AbortController();
    await fanoutQueue.listen(
      async () => {
        await Promise.all([
          deliveryQueue.enqueue(message("child-one"), {
            orderingKey: "article:one\nhttps://remote.example",
          }),
          deliveryQueue.enqueue(message("child-two"), {
            orderingKey: "article:one\nhttps://remote.example",
          }),
        ]);
        controller.abort();
      },
      { signal: controller.signal },
    );

    const rows = await tx
      .select({
        groupId: outboxEventTable.groupId,
        sequence: outboxEventTable.sequence,
        position: outboxEventTable.position,
      })
      .from(outboxEventTable)
      .where(eq(outboxEventTable.eventType, "activitypub.delivery"));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].groupId, rows[1].groupId);
    assert.equal(rows[0].sequence, rows[1].sequence);
    assert.deepEqual(rows.map((row) => row.position).sort(), [0, 1]);
  });
});

test("fanout side effects roll back before the event is retried", async () => {
  const suffix = crypto.randomUUID();
  const parentId = `fanout-rollback-${suffix}`;
  const childId = `delivery-rollback-${suffix}`;
  const fanoutQueue = new TransactionalOutboxQueue(
    testDb,
    "activitypub.fanout",
    {
      now: () => now,
      pollInterval: { milliseconds: 1 },
    },
  );
  const deliveryQueue = new TransactionalOutboxQueue(
    testDb,
    "activitypub.delivery",
    { now: () => now },
  );

  try {
    await fanoutQueue.enqueue({ type: "fanout", id: parentId });

    await fanoutQueue.listen(
      async () => {
        await deliveryQueue.enqueue(message(childId));
        throw new Error("fanout failed after enqueue");
      },
      { signal: AbortSignal.timeout(25) },
    );

    const rows = await testDb
      .select()
      .from(outboxEventTable)
      .where(inArray(outboxEventTable.messageId, [parentId, childId]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messageId, parentId);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].lastError?.message, "fanout failed after enqueue");
  } finally {
    await testDb
      .delete(outboxEventTable)
      .where(inArray(outboxEventTable.messageId, [parentId, childId]));
  }
});

test("fanout side effects roll back when the completion lease is stale", async () => {
  const suffix = crypto.randomUUID();
  const parentId = `fanout-stale-${suffix}`;
  const childId = `delivery-stale-${suffix}`;
  const reclaimedLeaseToken = crypto.randomUUID();
  const fanoutQueue = new TransactionalOutboxQueue(
    testDb,
    "activitypub.fanout",
    {
      now: () => now,
      pollInterval: { milliseconds: 1 },
    },
  );
  const deliveryQueue = new TransactionalOutboxQueue(
    testDb,
    "activitypub.delivery",
    { now: () => now },
  );
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(5_000),
  ]);

  try {
    await fanoutQueue.enqueue({ type: "fanout", id: parentId });

    await fanoutQueue.listen(
      async () => {
        try {
          await deliveryQueue.enqueue(message(childId));
          await testDb
            .update(outboxEventTable)
            .set({
              leaseToken: reclaimedLeaseToken,
            })
            .where(eq(outboxEventTable.messageId, parentId));
        } finally {
          // Let the async handler settle before stopping the listener so the
          // queue attempts completion and detects the replaced lease token.
          setTimeout(() => controller.abort(), 0);
        }
      },
      { signal },
    );
    assert.equal(
      controller.signal.aborted,
      true,
      "the fallback deadline elapsed before the handler completed",
    );

    const rows = await testDb
      .select()
      .from(outboxEventTable)
      .where(inArray(outboxEventTable.messageId, [parentId, childId]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].messageId, parentId);
    assert.equal(rows[0].status, "processing");
    assert.equal(rows[0].leaseToken, reclaimedLeaseToken);
  } finally {
    await testDb
      .delete(outboxEventTable)
      .where(inArray(outboxEventTable.messageId, [parentId, childId]));
  }
});

test("fanout retries survive an aborted database transaction", async () => {
  const messageId = `fanout-database-error-${crypto.randomUUID()}`;
  const queue = new TransactionalOutboxQueue(testDb, "activitypub.fanout", {
    now: () => now,
    pollInterval: { milliseconds: 1 },
  });

  try {
    await queue.enqueue({ type: "fanout", id: messageId });

    await queue.listen(
      async () => {
        const db = getCurrentOutboxDatabase();
        assert(db != null);
        await db.execute(sql`select 1 / 0`);
      },
      { signal: AbortSignal.timeout(25) },
    );

    const [row] = await testDb
      .select()
      .from(outboxEventTable)
      .where(eq(outboxEventTable.messageId, messageId));
    assert.equal(row.status, "pending");
    assert.equal(row.processingAttempts, 1);
    assert.match(row.lastError?.message ?? "", /select 1 \/ 0/);
  } finally {
    await testDb
      .delete(outboxEventTable)
      .where(eq(outboxEventTable.messageId, messageId));
  }
});

test("queue listener completes and redacts a delivered message", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const queue = new TransactionalOutboxQueue(tx, "activitypub.delivery", {
      now: () => now,
      pollInterval: { milliseconds: 1 },
    });
    await queue.enqueue(message("delivered"));

    const controller = new AbortController();
    const handled: unknown[] = [];
    await queue.listen(
      (value) => {
        handled.push(value);
        controller.abort();
      },
      { signal: controller.signal },
    );

    assert.deepEqual(handled, [message("delivered")]);
    const [row] = await tx
      .select()
      .from(outboxEventTable)
      .where(eq(outboxEventTable.messageId, "delivered"));
    assert.equal(row.status, "completed");
    assert.equal(row.payload, null);
  });
});

test("queue listener retries a handler that exceeds its timeout", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const queue = new TransactionalOutboxQueue(tx, "activitypub.delivery", {
      now: () => now,
      pollInterval: { milliseconds: 1 },
      handlerTimeout: { milliseconds: 5 },
    });
    await queue.enqueue(message("handler-timeout"));

    await queue.listen(() => new Promise(() => {}), {
      signal: AbortSignal.timeout(25),
    });

    const [row] = await tx.select().from(outboxEventTable);
    assert.equal(row.status, "pending");
    assert.equal(row.processingAttempts, 1);
    assert.equal(row.lastError?.name, "OutboxHandlerTimeoutError");
  });
});

test("aborting the listener releases a handler that has not settled", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const queue = new TransactionalOutboxQueue(tx, "activitypub.delivery", {
      now: () => now,
      handlerTimeout: { minutes: 5 },
    });
    await queue.enqueue(message("shutdown"));

    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const listening = queue.listen(
      () => {
        started.resolve();
        return new Promise(() => {});
      },
      { signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    await listening;

    const [row] = await tx.select().from(outboxEventTable);
    assert.equal(row.status, "pending");
    assert.equal(row.lastError?.name, "AbortError");
  });
});

test("Fedify retry updates the current row instead of inserting a duplicate", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const queue = new TransactionalOutboxQueue(tx, "activitypub.delivery", {
      now: () => now,
      pollInterval: { milliseconds: 1 },
    });
    await queue.enqueue(message("retry"));

    const controller = new AbortController();
    await queue.listen(
      async () => {
        recordOutboxDeliveryError(new Error("temporary"));
        await queue.enqueue(message("retry", 1), {
          delay: Temporal.Duration.from({ minutes: 5 }),
        });
        controller.abort();
      },
      { signal: controller.signal },
    );

    const rows = await tx.select().from(outboxEventTable);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.deepEqual(rows[0].payload, message("retry", 1));
    assert.equal(rows[0].lastError?.message, "temporary");
  });
});

test("Fedify retries stop at the configured processing-attempt limit", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const queue = new TransactionalOutboxQueue(tx, "activitypub.delivery", {
      now: () => now,
      pollInterval: { milliseconds: 1 },
      maximumProcessingAttempts: 1,
    });
    await queue.enqueue(message("retry-limit"));

    const controller = new AbortController();
    await queue.listen(
      async () => {
        recordOutboxDeliveryError(new Error("still unavailable"));
        await queue.enqueue(message("retry-limit", 1), {
          delay: Temporal.Duration.from({ minutes: 5 }),
        });
        controller.abort();
      },
      { signal: controller.signal },
    );

    const [row] = await tx.select().from(outboxEventTable);
    assert.equal(row.status, "dead");
    assert.equal(row.processingAttempts, 1);
    assert.equal(row.lastError?.message, "still unavailable");
  });
});

test("a delivery error without a Fedify retry becomes a dead letter", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const queue = new TransactionalOutboxQueue(tx, "activitypub.delivery", {
      now: () => now,
      pollInterval: { milliseconds: 1 },
    });
    await queue.enqueue(message("dead"));

    const controller = new AbortController();
    await queue.listen(
      () => {
        recordOutboxDeliveryError(new Error("permanent"));
        controller.abort();
      },
      { signal: controller.signal },
    );

    const [row] = await tx.select().from(outboxEventTable);
    assert.equal(row.status, "dead");
    assert.equal(row.lastError?.message, "permanent");
    assert.deepEqual(row.payload, message("dead"));
  });
});

test("unsupported payload versions become dead letters without delivery", async () => {
  await withRollback(async (tx) => {
    await tx.delete(outboxEventTable);
    const queue = new TransactionalOutboxQueue(tx, "activitypub.delivery", {
      now: () => now,
      pollInterval: { milliseconds: 1 },
    });
    await queue.enqueue(message("future-version"));
    await tx
      .update(outboxEventTable)
      .set({ payloadVersion: 2 })
      .where(eq(outboxEventTable.messageId, "future-version"));

    let handled = false;
    await queue.listen(
      () => {
        handled = true;
      },
      { signal: AbortSignal.timeout(20) },
    );

    assert.equal(handled, false);
    const [row] = await tx.select().from(outboxEventTable);
    assert.equal(row.status, "dead");
    assert.match(row.lastError?.message ?? "", /payload version 2/);
  });
});
