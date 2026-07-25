import assert from "node:assert/strict";
import test from "node:test";
import type { Cron } from "croner";
import {
  createNodeCron,
  type NodeCronFactory,
  runNodeWorkerScheduler,
} from "./worker-scheduler.node.ts";
import type { WorkerJob } from "./worker-jobs.ts";

const job: WorkerJob = {
  name: "test-job",
  schedule: "* * * * *",
  run: () => Promise.resolve(),
};

test("Node cron preserves UTC, five-field, and overlap protection", () => {
  const cron = createNodeCron(job, job.run, () => undefined) as Cron;
  try {
    assert.equal(cron.options.timezone, "UTC");
    assert.equal(cron.options.mode, "5-part");
    assert.equal(typeof cron.options.protect, "function");
  } finally {
    cron.stop();
  }
});

test("scheduler does not register jobs after shutdown was requested", async () => {
  let registrations = 0;
  const cronFactory: NodeCronFactory = () => {
    registrations++;
    return { stop() {} };
  };

  await runNodeWorkerScheduler([job], {
    signal: AbortSignal.abort(),
    cronFactory,
  });

  assert.equal(registrations, 0);
});

test("scheduler observes shutdown requested while jobs are registering", async () => {
  const controller = new AbortController();
  let stopped = false;
  const cronFactory: NodeCronFactory = () => {
    controller.abort();
    return {
      stop() {
        stopped = true;
      },
    };
  };

  await runNodeWorkerScheduler([job], {
    signal: controller.signal,
    cronFactory,
  });

  assert.equal(stopped, true);
});

test("scheduler stops future ticks and drains the active job", async () => {
  const controller = new AbortController();
  const completion = Promise.withResolvers<void>();
  let run: (() => Promise<void>) | undefined;
  let stopped = false;
  const cronFactory: NodeCronFactory = (_job, callback) => {
    run = callback;
    return {
      stop() {
        stopped = true;
      },
    };
  };
  const running = runNodeWorkerScheduler(
    [
      {
        ...job,
        async run() {
          await completion.promise;
        },
      },
    ],
    { signal: controller.signal, cronFactory },
  );
  assert(run != null);
  const jobRun = run();

  controller.abort();
  await Promise.resolve();
  assert.equal(stopped, true);
  let schedulerStopped = false;
  const observed = running.then(() => {
    schedulerStopped = true;
  });
  await Promise.resolve();
  assert.equal(schedulerStopped, false);

  completion.resolve();
  await Promise.all([jobRun, observed]);
  assert.equal(schedulerStopped, true);
});

test("scheduler warns but keeps waiting for an active job", async () => {
  const controller = new AbortController();
  let run: (() => Promise<void>) | undefined;
  const completion = Promise.withResolvers<void>();
  const warningSeen = Promise.withResolvers<void>();
  const warnings: Array<Record<string, unknown>> = [];
  const cronFactory: NodeCronFactory = (_job, callback) => {
    run = callback;
    return { stop() {} };
  };
  const running = runNodeWorkerScheduler(
    [
      {
        ...job,
        run: () => completion.promise,
      },
    ],
    {
      signal: controller.signal,
      cronFactory,
      drainWarningMilliseconds: 1,
      logger: {
        warning(_message, properties) {
          warnings.push(properties);
          warningSeen.resolve();
        },
      },
    },
  );
  assert(run != null);
  void run();

  controller.abort();

  await warningSeen.promise;
  let schedulerStopped = false;
  const observed = running.then(() => {
    schedulerStopped = true;
  });
  await Promise.resolve();
  assert.equal(schedulerStopped, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].warningAfterMilliseconds, 1);

  completion.resolve();
  await observed;
  assert.equal(schedulerStopped, true);
});

test("scheduler stops already-created jobs if registration fails", async () => {
  const controller = new AbortController();
  let stopped = false;
  let registration = 0;
  const failure = new Error("invalid schedule");
  const cronFactory: NodeCronFactory = () => {
    registration++;
    if (registration === 2) throw failure;
    return {
      stop() {
        stopped = true;
      },
    };
  };

  await assert.rejects(
    runNodeWorkerScheduler([job, { ...job, name: "second-job" }], {
      signal: controller.signal,
      cronFactory,
    }),
    failure,
  );
  assert.equal(stopped, true);
});

test("scheduler attempts every stop when a cron handle throws", async () => {
  const registrationFailure = new Error("invalid schedule");
  const stopFailure = new Error("stop failed");
  const stopAttempts: string[] = [];
  const warnings: Array<Record<string, unknown>> = [];
  let registration = 0;
  const cronFactory: NodeCronFactory = (registeredJob) => {
    registration++;
    if (registration === 3) throw registrationFailure;
    return {
      stop() {
        stopAttempts.push(registeredJob.name);
        if (registeredJob.name === "first-job") throw stopFailure;
      },
    };
  };

  await assert.rejects(
    runNodeWorkerScheduler(
      [
        { ...job, name: "first-job" },
        { ...job, name: "second-job" },
        { ...job, name: "third-job" },
      ],
      {
        signal: new AbortController().signal,
        cronFactory,
        logger: {
          warning(_message, properties) {
            warnings.push(properties);
          },
        },
      },
    ),
    (error) => error === registrationFailure,
  );
  assert.deepEqual(stopAttempts, ["first-job", "second-job"]);
  assert.equal(warnings.length, 1);
  assert.strictEqual(warnings[0].error, stopFailure);
});

test("scheduler preserves resources until active jobs settle after registration failure", async () => {
  const failure = new Error("invalid schedule");
  const completion = Promise.withResolvers<void>();
  const warningSeen = Promise.withResolvers<void>();
  let registration = 0;
  const cronFactory: NodeCronFactory = (_job, run) => {
    registration++;
    if (registration === 2) throw failure;
    void run();
    return { stop() {} };
  };

  const running = runNodeWorkerScheduler(
    [
      {
        ...job,
        run: () => completion.promise,
      },
      { ...job, name: "second-job" },
    ],
    {
      signal: new AbortController().signal,
      cronFactory,
      drainWarningMilliseconds: 1,
      logger: {
        warning(_message, properties) {
          if ("warningAfterMilliseconds" in properties) {
            warningSeen.resolve();
          }
        },
      },
    },
  );
  await warningSeen.promise;
  let failureReported = false;
  const observed = running.catch((error: unknown) => {
    failureReported = true;
    throw error;
  });
  await Promise.resolve();
  assert.equal(failureReported, false);

  completion.resolve();
  await assert.rejects(observed, (error) => error === failure);
});
