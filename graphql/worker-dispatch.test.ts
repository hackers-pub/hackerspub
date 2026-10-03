import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  outboxEventTable,
  scheduledWorkerDispatchTable,
  pollTable,
  postTable,
  notificationTable,
} from "@hackerspub/models/schema";
import { scheduledWorkerTask } from "@hackerspub/models/tasks";
import { notifyEndedPolls } from "@hackerspub/models/poll";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { createScheduledTaskWorker } from "../test/scheduled-tasks.ts";
import { waitForTaskCondition } from "../test/application-tasks.ts";
import { db } from "../test/database.ts";
import {
  insertAccountWithActor,
  withExclusiveTestDatabase,
  withRollback,
} from "../test/postgres.ts";
import {
  createWorkerDispatchJobs,
  dispatchScheduledWorkerJob,
} from "./worker-dispatch.ts";
import {
  createScheduledWorkerJobExecutor,
  type WorkerJob,
} from "./worker-jobs.ts";
import { runWorkerRuntime } from "./worker-runtime.ts";
import {
  runNodeWorkerScheduler,
  type NodeCronFactory,
} from "./worker-scheduler.ts";

const payload = {
  jobName: "prune-article-view-deduplications" as const,
  scheduled: "2026-10-03T03:45:00.000Z",
};

test("scheduled payload validation is stable and rejects unknown jobs/invalid ticks", () => {
  const validate = scheduledWorkerTask.schema["~standard"].validate;
  assert.deepEqual(validate(payload), { value: payload });
  for (const data of [
    { ...payload, jobName: "drain-news-rescore-queue" },
    { ...payload, scheduled: "2026-10-03T03:45:00Z" },
    { ...payload, scheduled: "2026-10-03T03:45:01.000Z" },
    { ...payload, scheduled: "invalid" },
  ])
    assert(validate(data).issues);
});

test("dispatch rollback restores both watermark and task intent", async () => {
  await withRollback(async (tx) => {
    const f = await createScheduledTaskWorker(tx, undefined);
    const failing = {
      ...f.context,
      withDatabase() {
        return {
          ...f.context,
          async enqueueTask() {
            throw new Error("enqueue failed");
          },
        };
      },
    };
    // A savepoint models rollback without aborting this test's outer fixture.
    await assert.rejects(
      tx.transaction(async (savepoint) => {
        await dispatchScheduledWorkerJob(
          { ...failing, db: savepoint },
          payload,
        );
      }),
      /enqueue failed/,
    );
    assert.equal(
      (await tx.select().from(scheduledWorkerDispatchTable)).length,
      0,
    );
    assert.equal((await tx.select().from(outboxEventTable)).length, 0);
    await tx
      .transaction(async (savepoint) => {
        await dispatchScheduledWorkerJob(
          f.context.withDatabase(savepoint),
          payload,
        );
        savepoint.rollback();
      })
      .catch((error: unknown) => {
        assert(error instanceof Error && error.message === "Rollback");
      });
    assert.equal(
      (await tx.select().from(scheduledWorkerDispatchTable)).length,
      0,
    );
    assert.equal((await tx.select().from(outboxEventTable)).length, 0);
    assert.equal(await dispatchScheduledWorkerJob(f.context, payload), true);
    assert.equal(await dispatchScheduledWorkerJob(f.context, payload), false);
  });
});

test("replica ticks dispatch once; newer intervals survive and older callbacks are skipped", async () => {
  await withExclusiveTestDatabase(async () => {
    const f = await createScheduledTaskWorker(db, undefined);
    try {
      const dispatched = await Promise.all(
        Array.from({ length: 4 }, () =>
          dispatchScheduledWorkerJob(f.context, payload),
        ),
      );
      assert.equal(dispatched.filter(Boolean).length, 1);
      const next = { ...payload, scheduled: "2026-10-04T03:45:00.000Z" };
      assert.equal(await dispatchScheduledWorkerJob(f.context, next), true);
      assert.equal(await dispatchScheduledWorkerJob(f.context, payload), false);
      const rows = await db.select().from(outboxEventTable);
      assert.equal(rows.length, 2);
      assert(
        rows.every(
          (row) =>
            row.orderingKey === `application.task:scheduled:${payload.jobName}`,
        ),
      );
      const [watermark] = await db.select().from(scheduledWorkerDispatchTable);
      assert.equal(watermark.scheduled.toISOString(), next.scheduled);
    } finally {
      await db
        .delete(outboxEventTable)
        .where(eq(outboxEventTable.eventType, "application.task"));
      await db.delete(scheduledWorkerDispatchTable);
    }
  });
});

test("dispatch jobs enqueue suitable work and retain the existing rescore drain", async () => {
  await withRollback(async (tx) => {
    const f = await createScheduledTaskWorker(tx, undefined);
    const executed: string[] = [];
    const jobs: WorkerJob[] = [
      {
        name: payload.jobName,
        schedule: "45 3 * * *",
        async run() {
          executed.push("queued");
        },
      },
      {
        name: "drain-news-rescore-queue",
        schedule: "* * * * *",
        async run() {
          executed.push("direct");
        },
      },
    ];
    const dispatch = createWorkerDispatchJobs(f.context, jobs);
    await dispatch[0].run(new Date(payload.scheduled));
    assert.deepEqual(executed, []);
    assert.equal((await tx.select().from(outboxEventTable)).length, 1);
    assert.equal(dispatch[1], jobs[1]);
    await dispatch[1].run();
    assert.deepEqual(executed, ["direct"]);
  });
});

test("queued intervals do not overlap; retries keep the original tick after partial work", async () => {
  await withRollback(async (tx) => {
    let clock = Date.now();
    const ticks: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let partialEffect = false;
    let effects = 0;
    const firstStarted = Promise.withResolvers<void>();
    const finishFirst = Promise.withResolvers<void>();
    const execute = createScheduledWorkerJobExecutor([
      {
        name: payload.jobName,
        schedule: "45 3 * * *",
        async run(scheduled) {
          assert(scheduled);
          ticks.push(scheduled.toISOString());
          active++;
          maximumActive = Math.max(maximumActive, active);
          try {
            if (ticks.length === 1) {
              firstStarted.resolve();
              await finishFirst.promise;
              // Idempotent partial side effect, then a retryable failure.
              partialEffect = true;
              effects++;
              throw new Error("controlled failure after partial work");
            }
            if (!partialEffect) effects++;
          } finally {
            active--;
          }
        },
      },
    ]);
    const f = await createScheduledTaskWorker(tx, execute, {
      now: () => new Date((clock += 10_000)),
    });
    await dispatchScheduledWorkerJob(f.context, payload);
    const next = { ...payload, scheduled: "2026-10-04T03:45:00.000Z" };
    await dispatchScheduledWorkerJob(f.context, next);
    const controller = new AbortController();
    const running = f.federation.startQueue(f.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await firstStarted.promise;
      const rows = await tx.select().from(outboxEventTable);
      assert.equal(rows.filter((row) => row.status === "processing").length, 1);
      assert.equal(rows.filter((row) => row.status === "pending").length, 1);
      finishFirst.resolve();
      await waitForTaskCondition(async () =>
        (await tx.select().from(outboxEventTable)).every(
          (row) => row.status === "completed",
        ),
      );
      assert.deepEqual(ticks, [
        payload.scheduled,
        payload.scheduled,
        next.scheduled,
      ]);
      assert.equal(maximumActive, 1);
      assert.equal(effects, 1);
    } finally {
      finishFirst.resolve();
      controller.abort();
      await running;
    }
  });
});

test("missing worker resources produce a visible dead scheduled task", async () => {
  await withRollback(async (tx) => {
    let clock = Date.now();
    const f = await createScheduledTaskWorker(tx, undefined, {
      now: () => new Date((clock += 10_000)),
    });
    await dispatchScheduledWorkerJob(f.context, payload);
    const controller = new AbortController();
    const running = f.federation.startQueue(f.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await waitForTaskCondition(
        async () =>
          (await tx.select().from(outboxEventTable))[0]?.status === "dead",
      );
      const [row] = await tx.select().from(outboxEventTable);
      assert.equal(row.processingAttempts, 3);
      assert.match(row.lastError?.message ?? "", /worker job resources/);
      assert(row.payload);
    } finally {
      controller.abort();
      await running;
    }
  });
});

test("poll task retry after notifications commit cannot duplicate results or claim later polls", async () => {
  await withRollback(async (tx) => {
    await tx.update(pollTable).set({ endedNotificationsSent: new Date() });
    const author = await insertAccountWithActor(tx, {
      username: "scheduledpoll",
      name: "Poll",
      email: "scheduledpoll@example.com",
    });
    const postIds = [generateUuidV7(), generateUuidV7()];
    for (const [index, id] of postIds.entries()) {
      await tx.insert(postTable).values({
        id,
        iri: `https://example.com/objects/${id}`,
        type: "Question",
        visibility: "public",
        actorId: author.actor.id,
        contentHtml: "<p>Poll</p>",
        language: "en",
        tags: {},
        emojis: {},
        published: new Date(),
        updated: new Date(),
      });
      await tx.insert(pollTable).values({
        postId: id,
        multiple: false,
        ends: new Date(
          Date.parse(payload.scheduled) + (index === 0 ? -60_000 : 60_000),
        ),
      });
    }
    let clock = Date.now();
    let calls = 0;
    const execute = createScheduledWorkerJobExecutor([
      {
        name: "notify-ended-polls",
        schedule: "* * * * *",
        async run(scheduled) {
          await notifyEndedPolls(tx, { now: scheduled });
          if (++calls === 1) throw new Error("failure after poll persistence");
        },
      },
    ]);
    const f = await createScheduledTaskWorker(tx, execute, {
      now: () => new Date((clock += 10_000)),
    });
    const data = { ...payload, jobName: "notify-ended-polls" as const };
    // Two distinct queue messages model duplicate delivery beyond enqueue
    // deduplication; the poll's own durable claim must still guard its effect.
    for (let i = 0; i < 2; i++)
      await f.context.enqueueTask(scheduledWorkerTask, data, {
        orderingKey: "scheduled:notify-ended-polls",
      });
    const controller = new AbortController();
    const running = f.federation.startQueue(f.data, {
      queue: "task",
      signal: controller.signal,
    });
    try {
      await waitForTaskCondition(async () =>
        (await tx.select().from(outboxEventTable)).every(
          (row) => row.status === "completed",
        ),
      );
      assert.equal(calls, 3);
      const notifications = await tx
        .select()
        .from(notificationTable)
        .where(eq(notificationTable.postId, postIds[0]));
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].type, "poll_ended");
      const [later] = await tx
        .select()
        .from(pollTable)
        .where(eq(pollTable.postId, postIds[1]));
      assert.equal(later.endedNotificationsSent, null);
    } finally {
      controller.abort();
      await running;
    }
  });
});

test("runtime waits for scheduler dispatch and actual task drain before releasing resources", async () => {
  await withRollback(async (tx) => {
    const executing = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let saved = false;
    const f = await createScheduledTaskWorker(tx, async () => {
      executing.resolve();
      await finish.promise;
      saved = true;
    });
    let tick: ((scheduled?: Date) => Promise<void>) | undefined;
    const cronFactory: NodeCronFactory = (_job, run) => {
      tick = run;
      return { stop() {} };
    };
    const dispatchJobs = createWorkerDispatchJobs(f.context, [
      {
        name: payload.jobName,
        schedule: "45 3 * * *",
        async run() {
          throw new Error("dispatch executed work locally");
        },
      },
    ]);
    const controller = new AbortController();
    const running = runWorkerRuntime({
      federation: f.federation,
      contextData: f.data,
      runScheduler: (signal) =>
        runNodeWorkerScheduler(dispatchJobs, { signal, cronFactory }),
      signal: controller.signal,
    });
    await waitForTaskCondition(async () => tick != null);
    assert(tick);
    await tick(new Date(payload.scheduled));
    await executing.promise;
    controller.abort();
    let resourcesClosed = false;
    const observed = running.then(() => {
      resourcesClosed = true;
    });
    assert.equal(resourcesClosed, false);
    try {
      // The scheduler is already stopped, but task completion owns the work.
      await tick(new Date("2026-10-04T03:45:00Z"));
      assert.equal((await tx.select().from(outboxEventTable)).length, 1);
      assert.equal(saved, false);
    } finally {
      finish.resolve();
      await observed;
    }
    assert.equal(saved, true);
    const [intent] = await tx.select().from(outboxEventTable);
    assert.equal(intent.status, "pending");
    assert.equal(intent.processingAttempts, 0);
    assert.equal(resourcesClosed, true);
  });
});
