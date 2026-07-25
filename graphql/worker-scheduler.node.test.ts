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

test("scheduler bounds draining an active job during shutdown", async () => {
  const controller = new AbortController();
  let run: (() => Promise<void>) | undefined;
  const warnings: Array<Record<string, unknown>> = [];
  const cronFactory: NodeCronFactory = (_job, callback) => {
    run = callback;
    return { stop() {} };
  };
  const running = runNodeWorkerScheduler(
    [
      {
        ...job,
        run: () => new Promise(() => undefined),
      },
    ],
    {
      signal: controller.signal,
      cronFactory,
      drainTimeoutMilliseconds: 1,
      logger: {
        warning(_message, properties) {
          warnings.push(properties);
        },
      },
    },
  );
  assert(run != null);
  void run();

  controller.abort();

  await running;
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0].error), /Timed out while draining/);
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

test("scheduler preserves registration and drain failures", async () => {
  const failure = new Error("invalid schedule");
  let registration = 0;
  const cronFactory: NodeCronFactory = (_job, run) => {
    registration++;
    if (registration === 2) throw failure;
    void run();
    return { stop() {} };
  };

  await assert.rejects(
    runNodeWorkerScheduler(
      [
        {
          ...job,
          run: () => new Promise(() => undefined),
        },
        { ...job, name: "second-job" },
      ],
      {
        signal: new AbortController().signal,
        cronFactory,
        drainTimeoutMilliseconds: 1,
      },
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.strictEqual(error.errors[0], failure);
      assert.match(String(error.errors[1]), /Timed out while draining/);
      return true;
    },
  );
});
