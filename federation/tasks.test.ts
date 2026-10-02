import assert from "node:assert/strict";
import test from "node:test";
import { eq, inArray } from "drizzle-orm";
import { MemoryKvStore } from "@fedify/fedify";
import type { Database } from "@hackerspub/models/db";
import { toApplicationContext } from "./context.ts";
import { builder as sharedBuilder } from "./mod.ts";
import { TransactionalOutboxQueue } from "./outbox-queue.ts";
import {
  claimOutboxEvent,
  completeOutboxEvent,
  failOutboxEvent,
  pruneOutboxEvents,
  replayApplicationTask,
} from "@hackerspub/models/outbox";
import {
  applicationTaskReceiptTable,
  outboxEventTable,
} from "@hackerspub/models/schema";
import {
  applicationTaskProbe,
  assertApplicationTaskPayload,
} from "@hackerspub/models/tasks";
import { withTransaction } from "@hackerspub/models/tx";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import {
  createTaskFixture,
  waitForTaskCondition,
} from "../test/application-tasks.ts";
import { db } from "../test/database.ts";
import {
  createFedCtx,
  withExclusiveTestDatabase,
  withRollback,
} from "../test/postgres.ts";

test("task payload validators are idempotent and reject codec/network objects", () => {
  const payload = { jobId: generateUuidV7() };
  assert.deepEqual(applicationTaskProbe.schema["~standard"].validate(payload), {
    value: payload,
  });
  assert.deepEqual(applicationTaskProbe.schema["~standard"].validate(payload), {
    value: payload,
  });
  assert(
    applicationTaskProbe.schema["~standard"].validate({ jobId: "invalid" })
      .issues,
  );
  for (const value of [
    new URL("https://example.com"),
    new Date(),
    new Map(),
    undefined,
    Infinity,
  ]) {
    assert.throws(() => assertApplicationTaskPayload({ value }), /plain JSON/);
  }
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => assertApplicationTaskPayload(circular), /plain JSON/);
});

test("task intent and application writes commit atomically, including enqueue failure", async () => {
  await withExclusiveTestDatabase(async () => {
    const fixture = await createTaskFixture(db);
    const rolledBack = generateUuidV7();
    const committed = generateUuidV7();
    const failed = generateUuidV7();
    // Structural typing accepts extra options; KV dedup must never escape SQL.
    const options = {
      orderingKey: "transaction-rollback",
      deduplicationKey: "transaction-rollback",
    };
    try {
      await assert.rejects(
        withTransaction(fixture.context, async (context) => {
          await context.db
            .insert(applicationTaskReceiptTable)
            .values({ jobId: rolledBack });
          await context.enqueueTask(
            fixture.task,
            { jobId: rolledBack },
            options,
          );
          throw new Error("rollback");
        }),
        /rollback/,
      );
      assert.equal((await fixture.queue.getDepth()).queued, 0);
      assert.equal(
        (
          await db
            .select()
            .from(applicationTaskReceiptTable)
            .where(eq(applicationTaskReceiptTable.jobId, rolledBack))
        ).length,
        0,
      );

      await withTransaction(fixture.context, async (context) => {
        await context.db
          .insert(applicationTaskReceiptTable)
          .values({ jobId: committed });
        await context.enqueueTask(fixture.task, { jobId: committed }, options);
      });
      const [event] = await db
        .select()
        .from(outboxEventTable)
        .where(eq(outboxEventTable.eventType, "application.task"));
      assert.equal(event.status, "pending"); // Producer has not started a consumer.
      assert.equal((await fixture.queue.getDepth()).queued, 1);

      const enqueue = fixture.queue.enqueue.bind(fixture.queue);
      fixture.queue.enqueue = () =>
        Promise.reject(new Error("persistent enqueue unavailable"));
      await assert.rejects(
        withTransaction(fixture.context, async (context) => {
          await context.db
            .insert(applicationTaskReceiptTable)
            .values({ jobId: failed });
          await context.enqueueTask(fixture.task, { jobId: failed });
        }),
        /persistent enqueue unavailable/,
      );
      fixture.queue.enqueue = enqueue;
      assert.equal(
        (
          await db
            .select()
            .from(applicationTaskReceiptTable)
            .where(eq(applicationTaskReceiptTable.jobId, failed))
        ).length,
        0,
      );
      assert.equal((await fixture.queue.getDepth()).queued, 1);
    } finally {
      await db
        .delete(outboxEventTable)
        .where(eq(outboxEventTable.eventType, "application.task"));
      await db
        .delete(applicationTaskReceiptTable)
        .where(
          inArray(applicationTaskReceiptTable.jobId, [
            rolledBack,
            committed,
            failed,
          ]),
        );
    }
  });
});

test("separate worker completes committed intents and duplicate deliveries are DB-idempotent", async () => {
  await withRollback(async (tx) => {
    const fixture = await createTaskFixture(tx);
    const jobId = generateUuidV7();
    await fixture.context.enqueueTask(fixture.task, { jobId });
    const [event] = await tx
      .select()
      .from(outboxEventTable)
      .where(eq(outboxEventTable.eventType, "application.task"));
    await fixture.queue.enqueue(event.payload); // Same transport id, no second row.
    await fixture.context.enqueueTask(fixture.task, { jobId }); // New transport id, same application job.
    assert.equal((await fixture.queue.getDepth()).queued, 2);
    const delivery = new TransactionalOutboxQueue(tx, "activitypub.delivery");
    assert.equal(
      await claimOutboxEvent(tx, "activitypub.delivery", {
        leaseDuration: { seconds: 1 },
      }),
      null,
    );
    await assert.rejects(delivery.enqueue(event.payload), /Invalid/);
    await assert.rejects(
      fixture.queue.enqueue({ type: "outbox", id: "invalid" }),
      /Invalid/,
    );
    const controller = new AbortController();
    const running = fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await waitForTaskCondition(
        async () =>
          (await fixture.queue.getDepth()).queued === 0 &&
          (
            await tx
              .select()
              .from(outboxEventTable)
              .where(eq(outboxEventTable.status, "completed"))
          ).length === 2,
      );
      assert.equal(
        (
          await tx
            .select()
            .from(applicationTaskReceiptTable)
            .where(eq(applicationTaskReceiptTable.jobId, jobId))
        ).length,
        1,
      );
    } finally {
      controller.abort();
      await running;
    }
  });
});

test("native task retries exhaust one bounded budget and replay resets it", async () => {
  await withRollback(async (tx) => {
    const attempts: number[] = [];
    let failing = true;
    let clock = Date.now();
    const fixture = await createTaskFixture(
      tx,
      async (_context, _data, execution) => {
        attempts.push(execution.attempt);
        if (failing) throw new Error("LLM unavailable");
      },
      { now: () => new Date((clock += 10_000)), concurrency: 1 },
    );
    assert.equal(fixture.queue.nativeRetrial, true);
    assert.equal(
      new TransactionalOutboxQueue(tx, "activitypub.delivery").nativeRetrial,
      false,
    );
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    const controller = new AbortController();
    const running = fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await waitForTaskCondition(
        async () =>
          (
            await tx
              .select()
              .from(outboxEventTable)
              .where(eq(outboxEventTable.status, "dead"))
          ).length === 1,
      );
      assert.deepEqual(attempts, [0, 1, 2]);
      const [dead] = await tx
        .select()
        .from(outboxEventTable)
        .where(eq(outboxEventTable.status, "dead"));
      assert.equal(dead.lastError?.message, "LLM unavailable");
      assert(dead.payload);
      failing = false;
      assert(await replayApplicationTask(tx, dead.id));
      await waitForTaskCondition(
        async () =>
          (
            await tx
              .select()
              .from(outboxEventTable)
              .where(eq(outboxEventTable.status, "completed"))
          ).length === 1,
      );
      assert.deepEqual(attempts, [0, 1, 2, 0]);
      assert.equal(await replayApplicationTask(tx, dead.id), false);
    } finally {
      controller.abort();
      await running;
    }
  });
});

test("application task replay cannot revive a dead ActivityPub delivery", async () => {
  await withRollback(async (tx) => {
    const delivery = new TransactionalOutboxQueue(tx, "activitypub.delivery");
    await delivery.enqueue({ type: "outbox", id: generateUuidV7() });
    const event = await claimOutboxEvent(tx, "activitypub.delivery", {
      leaseDuration: { minutes: 3 },
    });
    assert(event);
    assert(
      await failOutboxEvent(tx, event, {
        name: "DeliveryFailure",
        message: "Inbox permanently unavailable",
      }),
    );
    const [before] = await tx
      .select()
      .from(outboxEventTable)
      .where(eq(outboxEventTable.id, event.id));
    assert.equal(await replayApplicationTask(tx, event.id), false);
    const [after] = await tx
      .select()
      .from(outboxEventTable)
      .where(eq(outboxEventTable.id, event.id));
    assert.equal(after.status, "dead");
    assert.deepEqual(after, before);
  });
});

test("unknown, undecodable, and schema-invalid tasks remain recoverable dead letters", async () => {
  await withRollback(async (tx) => {
    const fixture = await createTaskFixture(tx);
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    const [event] = await tx
      .select()
      .from(outboxEventTable)
      .where(eq(outboxEventTable.eventType, "application.task"));
    const original = event.payload as Record<string, unknown>;
    const bad = [
      { ...original, id: crypto.randomUUID(), taskName: "future.task.v1" },
      { ...original, id: crypto.randomUUID(), data: "not devalue" },
      {
        ...original,
        id: crypto.randomUUID(),
        data: '[{"jobId":1},"not-a-uuid"]',
      },
    ];
    for (const message of bad) await fixture.queue.enqueue(message);
    const controller = new AbortController();
    const running = fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await waitForTaskCondition(
        async () =>
          (
            await tx
              .select()
              .from(outboxEventTable)
              .where(eq(outboxEventTable.status, "dead"))
          ).length === 3,
      );
      const dead = await tx
        .select()
        .from(outboxEventTable)
        .where(eq(outboxEventTable.status, "dead"));
      assert(
        dead.every(
          (row) =>
            row.payload != null &&
            row.lastError?.name === "TaskDispatchRejectedError",
        ),
      );
      await pruneOutboxEvents(tx, {
        completedBefore: new Date("2100-01-01"),
        failedBefore: new Date("2100-01-01"),
      });
      assert.equal((await tx.select().from(outboxEventTable)).length, 3);
      // Restore compatible data before replaying a schema/decode drop.
      for (const row of dead) {
        await tx
          .update(outboxEventTable)
          .set({ payload: { ...original, id: row.messageId } })
          .where(eq(outboxEventTable.id, row.id));
        assert(await replayApplicationTask(tx, row.id));
      }
      await waitForTaskCondition(
        async () =>
          (
            await tx
              .select()
              .from(outboxEventTable)
              .where(eq(outboxEventTable.status, "completed"))
          ).length === 3,
      );
    } finally {
      controller.abort();
      await running;
    }
  });
});

test("task shutdown drains actual handlers, preserves heartbeats, and does not consume attempts", async () => {
  await withRollback(async (tx) => {
    let release = Promise.withResolvers<void>();
    let entered = Promise.withResolvers<AbortSignal>();
    const fixture = await createTaskFixture(
      tx,
      async (_context, _data, execution) => {
        entered.resolve(execution.signal);
        await release.promise;
      },
      {
        concurrency: 1,
        maximumProcessingAttempts: 1,
        heartbeatInterval: { milliseconds: 5 },
      },
    );
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    for (let interruption = 0; interruption < 4; interruption++) {
      const controller = new AbortController();
      // startQueue caches listeners, so use its real dispatcher with a fresh listen.
      const running = fixture.queue.listen(
        (message) =>
          fixture.federation.processQueuedTask(fixture.data, message as never),
        { signal: controller.signal },
      );
      const executionSignal = await entered.promise;
      controller.abort();
      assert(executionSignal.aborted);
      let stopped = false;
      void running.then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(stopped, false);
      const [processing] = await tx.select().from(outboxEventTable);
      assert.equal(processing.status, "processing");
      release.resolve();
      await running;
      const [pending] = await tx.select().from(outboxEventTable);
      assert.equal(pending.status, "pending");
      assert.equal(pending.processingAttempts, 0);
      assert.equal(pending.lastError?.details?.interruptions, interruption + 1);
      release = Promise.withResolvers<void>();
      entered = Promise.withResolvers<AbortSignal>();
    }
  });
});

test("task heartbeat must leave a full interval before the lease safety deadline", () => {
  for (const heartbeat of [100, 120]) {
    assert.throws(
      () =>
        new TransactionalOutboxQueue(db, "application.task", {
          leaseDuration: { milliseconds: 200 },
          heartbeatInterval: { milliseconds: heartbeat },
        }),
      /heartbeat shorter than half the lease/,
    );
  }
});

test("shutdown after a deadline does not refund the failed task attempt", async () => {
  await withRollback(async (tx) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const fixture = await createTaskFixture(
      tx,
      async (_context, _data, execution) => {
        entered.resolve(execution.signal);
        await release.promise;
      },
      {
        concurrency: 1,
        handlerTimeout: { milliseconds: 15 },
        maximumProcessingAttempts: 1,
      },
    );
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    const controller = new AbortController();
    const running = fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      const signal = await entered.promise;
      await waitForTaskCondition(async () => signal.aborted);
      assert.equal(signal.reason.name, "ApplicationTaskTimeoutError");
      controller.abort();
      release.resolve();
      await running;
      const [event] = await tx.select().from(outboxEventTable);
      assert.equal(event.status, "dead");
      assert.equal(event.processingAttempts, 1);
      assert.equal(event.lastError?.name, "ApplicationTaskTimeoutError");
    } finally {
      controller.abort();
      release.resolve();
      await running;
    }
  });
});

test("task deadline drains late success and dead-letters instead of acknowledging it", async () => {
  await withRollback(async (tx) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const fixture = await createTaskFixture(
      tx,
      async (_context, _data, execution) => {
        entered.resolve(execution.signal);
        await release.promise;
      },
      {
        concurrency: 1,
        handlerTimeout: { milliseconds: 15 },
        maximumProcessingAttempts: 1,
      },
    );
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    const controller = new AbortController();
    const running = fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      const signal = await entered.promise;
      await waitForTaskCondition(async () => signal.aborted);
      assert.equal(signal.reason.name, "ApplicationTaskTimeoutError");
      assert.equal(
        (await tx.select().from(outboxEventTable))[0].status,
        "processing",
      );
      release.resolve();
      await waitForTaskCondition(
        async () =>
          (await tx.select().from(outboxEventTable))[0].status === "dead",
      );
      assert.equal(
        (await tx.select().from(outboxEventTable))[0].lastError?.name,
        "ApplicationTaskTimeoutError",
      );
    } finally {
      release.resolve();
      controller.abort();
      await running;
    }
  });
});

test("concurrent task loops never acknowledge unfinished work or overlap an ordering key", async () => {
  await withRollback(async (tx) => {
    const release = Promise.withResolvers<void>();
    const started: string[] = [];
    const fixture = await createTaskFixture(tx, async (_context, data) => {
      started.push(data.jobId);
      await release.promise;
    });
    const ids = [generateUuidV7(), generateUuidV7(), generateUuidV7()];
    await fixture.context.enqueueTask(
      fixture.task,
      { jobId: ids[0] },
      { orderingKey: "shared" },
    );
    await fixture.context.enqueueTask(
      fixture.task,
      { jobId: ids[1] },
      { orderingKey: "shared" },
    );
    await fixture.context.enqueueTask(fixture.task, { jobId: ids[2] });
    const controller = new AbortController();
    const running = fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await waitForTaskCondition(async () => started.length === 2);
      assert.deepEqual(new Set(started), new Set([ids[0], ids[2]]));
      assert.equal(
        (
          await tx
            .select()
            .from(outboxEventTable)
            .where(eq(outboxEventTable.status, "completed"))
        ).length,
        0,
      );
      release.resolve();
      await waitForTaskCondition(
        async () =>
          started.length === 3 && (await fixture.queue.getDepth()).queued === 0,
      );
    } finally {
      release.resolve();
      controller.abort();
      await running;
    }
  });
});

test("terminated task leases are reclaimed only after expiry and stale tokens cannot complete", async () => {
  await withRollback(async (tx) => {
    const fixture = await createTaskFixture(tx);
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    const now = new Date();
    const first = await claimOutboxEvent(tx, "application.task", {
      now,
      leaseDuration: { seconds: 3 },
    });
    assert(first);
    assert.equal(
      await claimOutboxEvent(tx, "application.task", {
        now: new Date(now.getTime() + 2999),
        leaseDuration: { seconds: 3 },
      }),
      null,
    );
    const second = await claimOutboxEvent(tx, "application.task", {
      now: new Date(now.getTime() + 3001),
      leaseDuration: { seconds: 3 },
    });
    assert(second);
    assert.equal(second.id, first.id);
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.equal(await completeOutboxEvent(tx, first), false);
    assert(await completeOutboxEvent(tx, second));
  });
});

test("shared probe registration and exact handles survive independent API/worker builds", async () => {
  await withRollback(async (tx) => {
    const producerQueue = new TransactionalOutboxQueue(tx, "application.task");
    const consumerQueue = new TransactionalOutboxQueue(tx, "application.task", {
      pollInterval: { milliseconds: 2 },
    });
    const makeFederation = (queue: TransactionalOutboxQueue) =>
      sharedBuilder.build({
        kv: new MemoryKvStore(),
        queue: { task: queue },
        manuallyStartQueue: true,
        taskQueueResolution: "strict",
      });
    const producer = await makeFederation(producerQueue);
    const consumer = await makeFederation(consumerQueue);
    const data = createFedCtx(tx).data;
    const context = toApplicationContext(
      producer.createContext(new URL("https://example.com"), data),
    );
    const jobId = generateUuidV7();
    await context.enqueueTask(applicationTaskProbe, { jobId });
    assert.equal(
      (await tx.select().from(outboxEventTable))[0].status,
      "pending",
    );
    const controller = new AbortController();
    const running = consumer.startQueue(data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await waitForTaskCondition(
        async () =>
          (
            await tx
              .select()
              .from(applicationTaskReceiptTable)
              .where(eq(applicationTaskReceiptTable.jobId, jobId))
          ).length === 1,
      );
    } finally {
      controller.abort();
      await running;
    }
  });
});

function failLeaseRenewals(
  database: Database,
  reject: () => boolean,
): Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "update")
        return (table: Parameters<Database["update"]>[0]) => {
          const update = target.update(table);
          return new Proxy(update, {
            get(builder, key) {
              if (key === "set")
                return (values: Record<string, unknown>) => {
                  if (
                    values.leased instanceof Date &&
                    !("status" in values) &&
                    reject()
                  ) {
                    return {
                      where: () => ({
                        returning: () =>
                          Promise.reject(
                            new Error("transient heartbeat outage"),
                          ),
                      }),
                    };
                  }
                  return builder.set(values);
                };
              const value = Reflect.get(builder, key);
              return typeof value === "function" ? value.bind(builder) : value;
            },
          });
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("a transient heartbeat error is tolerated but sustained renewal failure cancels work", async () => {
  await withRollback(async (tx) => {
    let failures = 0;
    let sustained = false;
    const flaky = failLeaseRenewals(tx, () => {
      failures++;
      return sustained || failures === 1;
    });
    let release = Promise.withResolvers<void>();
    let entered = Promise.withResolvers<AbortSignal>();
    const fixture = await createTaskFixture(
      flaky,
      async (_context, _data, execution) => {
        entered.resolve(execution.signal);
        await release.promise;
      },
      {
        concurrency: 1,
        leaseDuration: { milliseconds: 200 },
        heartbeatInterval: { milliseconds: 20 },
        maximumProcessingAttempts: 1,
      },
    );
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    const controller = new AbortController();
    const running = fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      const first = await entered.promise;
      await waitForTaskCondition(async () => failures >= 3);
      assert.equal(first.aborted, false);
      release.resolve();
      await waitForTaskCondition(
        async () =>
          (await tx.select().from(outboxEventTable))[0].status === "completed",
      );
      sustained = true;
      release = Promise.withResolvers<void>();
      entered = Promise.withResolvers<AbortSignal>();
      await fixture.context.enqueueTask(fixture.task, {
        jobId: generateUuidV7(),
      });
      const second = await entered.promise;
      await waitForTaskCondition(async () => second.aborted);
      assert.match(second.reason.message, /lease could not be renewed/);
      release.resolve();
      await waitForTaskCondition(
        async () =>
          (
            await tx
              .select()
              .from(outboxEventTable)
              .where(eq(outboxEventTable.status, "dead"))
          ).length === 1,
      );
    } finally {
      release.resolve();
      controller.abort();
      await running;
    }
  });
});

test("definitive lease loss cancels the old handler and fences its final update", async () => {
  await withRollback(async (tx) => {
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const fixture = await createTaskFixture(
      tx,
      async (_context, _data, execution) => {
        entered.resolve(execution.signal);
        await release.promise;
      },
      { concurrency: 1, heartbeatInterval: { milliseconds: 5 } },
    );
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    const controller = new AbortController();
    const running = fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      const signal = await entered.promise;
      const token = generateUuidV7();
      await tx.update(outboxEventTable).set({ leaseToken: token });
      await waitForTaskCondition(async () => signal.aborted);
      assert.match(signal.reason.message, /lease was lost/);
      release.resolve();
      controller.abort();
      await running;
      const [event] = await tx.select().from(outboxEventTable);
      assert.equal(event.status, "processing");
      assert.equal(event.leaseToken, token);
    } finally {
      release.resolve();
      controller.abort();
      await running;
    }
  });
});

test("crash exhaustion and incompatible envelope versions retain operator evidence", async () => {
  await withRollback(async (tx) => {
    let calls = 0;
    const fixture = await createTaskFixture(tx, async () => {
      calls++;
    });
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    const [crashed] = await tx.select().from(outboxEventTable);
    await tx
      .update(outboxEventTable)
      .set({
        processingAttempts: 3,
        lastError: { name: "PreviousFailure", message: "old failure" },
      })
      .where(eq(outboxEventTable.id, crashed.id));
    await fixture.context.enqueueTask(fixture.task, {
      jobId: generateUuidV7(),
    });
    await tx
      .update(outboxEventTable)
      .set({ payloadVersion: 2 })
      .where(eq(outboxEventTable.processingAttempts, 0));
    const controller = new AbortController();
    const running = fixture.federation.startQueue(fixture.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await waitForTaskCondition(
        async () =>
          (
            await tx
              .select()
              .from(outboxEventTable)
              .where(eq(outboxEventTable.status, "dead"))
          ).length === 2,
      );
      assert.equal(calls, 0);
      const [dead] = await tx
        .select()
        .from(outboxEventTable)
        .where(eq(outboxEventTable.id, crashed.id));
      assert.deepEqual(dead.lastError?.details?.previous, {
        name: "PreviousFailure",
        message: "old failure",
      });
    } finally {
      controller.abort();
      await running;
    }
  });
});
