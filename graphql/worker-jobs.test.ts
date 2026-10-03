import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "@hackerspub/models/db";
import { SCHEDULED_WORKER_JOB_NAMES } from "@hackerspub/models/tasks";
import type { Transport } from "@upyo/core";
import {
  createWorkerJobs,
  createScheduledWorkerJobExecutor,
  type WorkerJobOperations,
  waitForWorkerJobsToDrain,
  WorkerJobRunner,
  WORKER_JOB_SCHEDULES,
} from "./worker-jobs.ts";

const email = {} as Transport;

function createDatabase(locked = true): Database {
  return {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      await callback({
        execute: async () => [{ locked }],
      }),
  } as unknown as Database;
}

function createOperations(
  overrides: Partial<WorkerJobOperations> = {},
): WorkerJobOperations {
  return {
    sweepExpiredSuspensionRescores: async () => 0,
    drainNewsRescoreQueue: async () => ({
      actorsProcessed: 0,
      linksRecomputed: 0,
    }),
    recomputeNewsScores: async () => ({
      linksUpdated: 0,
      recomputed: new Date(0),
    }),
    notifyEndedPolls: async () => ({
      pollsProcessed: 0,
      notificationsCreated: 0,
    }),
    sendNotificationDigests: async () => ({
      accountsChecked: 0,
      accountsClaimed: 0,
      emailsSent: 0,
      accountsFailed: 0,
    }),
    pruneOutboxEvents: async () => 0,
    pruneExpiredArticleViewDeduplications: async () => 0,
    ...overrides,
  };
}

test("worker job schedules preserve the Deno worker cadence", () => {
  assert.deepEqual(Object.values(WORKER_JOB_SCHEDULES), [
    { name: "recompute-news-scores", schedule: "*/5 * * * *" },
    { name: "drain-news-rescore-queue", schedule: "* * * * *" },
    { name: "notify-ended-polls", schedule: "* * * * *" },
    { name: "send-weekly-notification-digests", schedule: "0 0 * * 1" },
    { name: "send-daily-notification-digests", schedule: "5 0 * * *" },
    { name: "prune-transactional-outbox", schedule: "30 3 * * *" },
    { name: "prune-article-view-deduplications", schedule: "45 3 * * *" },
  ]);
});

test("durable task names cover every scheduled job except the leased rescore drain", () => {
  const jobs = createWorkerJobs({
    db: createDatabase(),
    email,
    emailFrom: "admin@example.com",
    origin: "https://example.com/",
  });
  assert.deepEqual(
    jobs
      .map((job) => job.name)
      .filter((name) => name !== "drain-news-rescore-queue")
      .sort(),
    [...SCHEDULED_WORKER_JOB_NAMES].sort(),
  );
});

test("news score sweep skips work when another replica holds the lock", async () => {
  let recomputed = false;
  const jobs = createWorkerJobs(
    {
      db: createDatabase(false),
      email,
      emailFrom: "admin@example.com",
      origin: "https://example.com/",
    },
    {
      operations: createOperations({
        recomputeNewsScores: async () => {
          recomputed = true;
          return { linksUpdated: 1, recomputed: new Date(0) };
        },
      }),
    },
  );

  await jobs[0].run();

  assert.equal(recomputed, false);
});

test("news score sweep uses the one-hour active window after locking", async () => {
  const current = new Date("2026-07-25T12:00:00Z");
  let activeSince: Date | undefined;
  const jobs = createWorkerJobs(
    {
      db: createDatabase(),
      email,
      emailFrom: "admin@example.com",
      origin: "https://example.com/",
    },
    {
      now: () => current,
      operations: createOperations({
        recomputeNewsScores: async (_db, options) => {
          activeSince = options?.activeSince;
          return { linksUpdated: 1, recomputed: current };
        },
      }),
    },
  );

  await jobs[0].run();

  assert.equal(activeSince?.toISOString(), "2026-07-25T11:00:00.000Z");
});

test("digest and pruning jobs preserve their operation arguments", async () => {
  const current = new Date("2026-07-25T12:00:00Z");
  const frequencies: string[] = [];
  let completedBefore: Date | undefined;
  let failedBefore: Date | undefined;
  let deduplicationBefore: Date | undefined;
  const db = createDatabase();
  const jobs = createWorkerJobs(
    {
      db,
      email,
      emailFrom: "admin@example.com",
      origin: "https://example.com/",
    },
    {
      now: () => current,
      operations: createOperations({
        sendNotificationDigests: async (options) => {
          frequencies.push(options.frequency);
          assert.equal(options.db, db);
          assert.equal(options.email, email);
          assert.equal(options.from, "admin@example.com");
          assert.equal(options.origin, "https://example.com/");
          return {
            accountsChecked: 0,
            accountsClaimed: 0,
            emailsSent: 0,
            accountsFailed: 0,
          };
        },
        pruneOutboxEvents: async (_db, options) => {
          completedBefore = options.completedBefore;
          failedBefore = options.failedBefore;
          return 0;
        },
        pruneExpiredArticleViewDeduplications: async (_db, before) => {
          deduplicationBefore = before;
          return 0;
        },
      }),
    },
  );

  await jobs[3].run();
  await jobs[4].run();
  await jobs[5].run();
  await jobs[6].run();

  assert.deepEqual(frequencies, ["weekly", "daily"]);
  assert.equal(completedBefore?.toISOString(), "2026-07-24T12:00:00.000Z");
  assert.equal(failedBefore?.toISOString(), "2026-06-25T12:00:00.000Z");
  assert.equal(deduplicationBefore?.toISOString(), "2026-07-25T12:00:00.000Z");
});

test("worker job runner contains failures and drains active work", async () => {
  const errors: Record<string, unknown>[] = [];
  const runner = new WorkerJobRunner({
    error(_message, properties) {
      errors.push(properties);
    },
  });
  const completion = Promise.withResolvers<void>();
  const running = runner.run({
    name: "failing-job",
    schedule: "* * * * *",
    async run() {
      await completion.promise;
      throw new Error("boom");
    },
  });
  let drained = false;
  const draining = runner.drain().then(() => {
    drained = true;
  });

  await Promise.resolve();
  assert.equal(drained, false);
  completion.resolve();
  await Promise.all([running, draining]);

  assert.equal(drained, true);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].jobName, "failing-job");
  assert(errors[0].error instanceof Error);
});

test("slow job drains warn without releasing shared resources", async () => {
  const completion = Promise.withResolvers<void>();
  const warningSeen = Promise.withResolvers<void>();
  let drained = false;
  const draining = waitForWorkerJobsToDrain(
    () => completion.promise,
    1,
    warningSeen.resolve,
  ).then(() => {
    drained = true;
  });

  await warningSeen.promise;
  assert.equal(drained, false);

  completion.resolve();
  await draining;
  assert.equal(drained, true);
});

test("delayed scheduled jobs freeze every interval-sensitive operation input", async () => {
  const tick = new Date("2026-10-05T00:05:00Z");
  const later = new Date("2026-10-20T12:00:00Z");
  const inputs: Record<string, string | undefined> = {};
  const jobs = createWorkerJobs(
    {
      db: createDatabase(),
      email,
      emailFrom: "admin@example.com",
      origin: "https://example.com",
    },
    {
      now: () => later,
      operations: createOperations({
        recomputeNewsScores: async (_db, options) => {
          inputs.news = options?.activeSince?.toISOString();
          return { linksUpdated: 0, recomputed: later };
        },
        notifyEndedPolls: async (_db, options) => {
          inputs.poll = options?.now?.toISOString();
          return { pollsProcessed: 0, notificationsCreated: 0 };
        },
        sendNotificationDigests: async (options) => {
          inputs[options.frequency] = options.now?.toISOString();
          return {
            accountsChecked: 0,
            accountsClaimed: 0,
            emailsSent: 0,
            accountsFailed: 0,
          };
        },
        pruneOutboxEvents: async (_db, options) => {
          inputs.completed = options.completedBefore.toISOString();
          inputs.failed = options.failedBefore.toISOString();
          return 0;
        },
        pruneExpiredArticleViewDeduplications: async (_db, cutoff) => {
          inputs.views = cutoff?.toISOString();
          return 0;
        },
      }),
    },
  );
  for (const job of jobs) {
    if (job.name !== "drain-news-rescore-queue") await job.run(tick);
  }
  assert.deepEqual(inputs, {
    news: "2026-10-04T23:05:00.000Z",
    poll: tick.toISOString(),
    weekly: tick.toISOString(),
    daily: tick.toISOString(),
    completed: "2026-10-04T00:05:00.000Z",
    failed: "2026-09-05T00:05:00.000Z",
    views: tick.toISOString(),
  });
});

test("digest account failures reach task retry and executor drains canceled work", async () => {
  const jobs = createWorkerJobs(
    {
      db: createDatabase(),
      email,
      emailFrom: "admin@example.com",
      origin: "https://example.com",
    },
    {
      operations: createOperations({
        sendNotificationDigests: async () => ({
          accountsChecked: 2,
          accountsClaimed: 2,
          emailsSent: 1,
          accountsFailed: 1,
        }),
      }),
    },
  );
  const execution = { signal: new AbortController().signal, attempt: 0 };
  const payload = {
    jobName: "send-daily-notification-digests" as const,
    scheduled: "2026-10-05T00:05:00.000Z",
  };
  await assert.rejects(
    createScheduledWorkerJobExecutor(jobs)(payload, execution),
    /daily digest account.*failed/,
  );

  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let saved = false;
  const execute = createScheduledWorkerJobExecutor([
    {
      name: payload.jobName,
      schedule: "5 0 * * *",
      async run() {
        started.resolve();
        await finished.promise;
        saved = true;
      },
    },
  ]);
  const running = execute(payload, { signal: controller.signal, attempt: 0 });
  await started.promise;
  controller.abort();
  assert.equal(saved, false);
  finished.resolve();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(saved, true);
});
