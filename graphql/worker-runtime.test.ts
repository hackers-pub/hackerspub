import assert from "node:assert/strict";
import test from "node:test";
import { runWorkerRuntime } from "./worker-runtime.ts";

function waitForAbort(signal: AbortSignal, events: string[], name: string) {
  return new Promise<void>((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        events.push(`${name}-stopped`);
        resolve();
      },
      { once: true },
    );
  });
}

function rejectOnAbort(signal: AbortSignal, started: () => void) {
  return new Promise<void>((_resolve, reject) => {
    started();
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("service stopped", "AbortError")),
      { once: true },
    );
  });
}

test("worker runtime stops and awaits both services on an external signal", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const queueStarted = Promise.withResolvers<void>();
  const schedulerStarted = Promise.withResolvers<void>();
  const running = runWorkerRuntime({
    federation: {
      startQueue(_contextData: undefined, options = {}) {
        events.push("queue-started");
        queueStarted.resolve();
        return waitForAbort(options.signal!, events, "queue");
      },
    },
    contextData: undefined,
    runScheduler(signal) {
      events.push("scheduler-started");
      schedulerStarted.resolve();
      return waitForAbort(signal, events, "scheduler");
    },
    signal: controller.signal,
  });
  await Promise.all([queueStarted.promise, schedulerStarted.promise]);

  controller.abort();
  await running;

  assert.deepEqual(events, [
    "queue-started",
    "scheduler-started",
    "queue-stopped",
    "scheduler-stopped",
  ]);
});

test("worker runtime ignores service abort errors during external shutdown", async () => {
  const controller = new AbortController();
  const queueStarted = Promise.withResolvers<void>();
  const schedulerStarted = Promise.withResolvers<void>();
  const running = runWorkerRuntime({
    federation: {
      startQueue(_contextData: undefined, options = {}) {
        return rejectOnAbort(options.signal!, queueStarted.resolve);
      },
    },
    contextData: undefined,
    runScheduler(signal) {
      return rejectOnAbort(signal, schedulerStarted.resolve);
    },
    signal: controller.signal,
  });
  await Promise.all([queueStarted.promise, schedulerStarted.promise]);

  controller.abort();

  await running;
});

test("worker runtime keeps resources open until the queue is safe", async () => {
  const controller = new AbortController();
  const queueStarted = Promise.withResolvers<void>();
  const queueCompletion = Promise.withResolvers<void>();
  const schedulerStarted = Promise.withResolvers<void>();
  const running = runWorkerRuntime({
    federation: {
      startQueue(_contextData: undefined, options = {}) {
        queueStarted.resolve();
        return new Promise<void>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            async () => {
              await queueCompletion.promise;
              resolve();
            },
            { once: true },
          );
        });
      },
    },
    contextData: undefined,
    runScheduler(signal) {
      schedulerStarted.resolve();
      return waitForAbort(signal, [], "scheduler");
    },
    signal: controller.signal,
  });
  await Promise.all([queueStarted.promise, schedulerStarted.promise]);

  let runtimeStopped = false;
  const observed = running.then(() => {
    runtimeStopped = true;
  });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtimeStopped, false);

  queueCompletion.resolve();
  await observed;
  assert.equal(runtimeStopped, true);
});

test("worker runtime keeps resources open for a draining scheduler", async () => {
  const controller = new AbortController();
  const schedulerStarted = Promise.withResolvers<void>();
  const schedulerCompletion = Promise.withResolvers<void>();
  const running = runWorkerRuntime({
    federation: {
      startQueue(_contextData: undefined, options = {}) {
        return waitForAbort(options.signal!, [], "queue");
      },
    },
    contextData: undefined,
    runScheduler(signal) {
      schedulerStarted.resolve();
      return new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          async () => {
            await schedulerCompletion.promise;
            resolve();
          },
          { once: true },
        );
      });
    },
    signal: controller.signal,
  });
  await schedulerStarted.promise;

  let runtimeStopped = false;
  const observed = running.then(() => {
    runtimeStopped = true;
  });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtimeStopped, false);

  schedulerCompletion.resolve();
  await observed;
  assert.equal(runtimeStopped, true);
});

test("worker runtime rejects an unexpected clean queue stop", async () => {
  const schedulerStopped = Promise.withResolvers<void>();

  await assert.rejects(
    runWorkerRuntime({
      federation: {
        startQueue: () => Promise.resolve(),
      },
      contextData: undefined,
      runScheduler(signal) {
        return waitForAbort(signal, [], "scheduler").finally(() => {
          schedulerStopped.resolve();
        });
      },
    }),
    /queue stopped unexpectedly/,
  );
  await schedulerStopped.promise;
});

for (const failedService of ["queue", "scheduler"] as const) {
  test(`worker runtime preserves an unexpected ${failedService} abort error`, async () => {
    const failure = new DOMException(
      `${failedService} stopped unexpectedly`,
      "AbortError",
    );

    await assert.rejects(
      runWorkerRuntime({
        federation: {
          startQueue(_contextData: undefined, options = {}) {
            return failedService === "queue"
              ? Promise.reject(failure)
              : waitForAbort(options.signal!, [], "queue");
          },
        },
        contextData: undefined,
        runScheduler(signal) {
          return failedService === "scheduler"
            ? Promise.reject(failure)
            : waitForAbort(signal, [], "scheduler");
        },
      }),
      (error) => error === failure,
    );
  });
}

test("worker runtime propagates a queue failure and aborts the scheduler", async () => {
  const failure = new Error("queue failed");
  let schedulerAborted = false;

  await assert.rejects(
    runWorkerRuntime({
      federation: {
        startQueue: () => Promise.reject(failure),
      },
      contextData: undefined,
      runScheduler(signal) {
        return new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              schedulerAborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    }),
    failure,
  );
  assert.equal(schedulerAborted, true);
});

test("worker runtime preserves a scheduler failure after the queue stops", async () => {
  const failure = new Error("scheduler failed");

  await assert.rejects(
    runWorkerRuntime({
      federation: {
        startQueue(_contextData: undefined, options = {}) {
          return waitForAbort(options.signal!, [], "queue");
        },
      },
      contextData: undefined,
      runScheduler: () => Promise.reject(failure),
    }),
    (error) => error === failure,
  );
});

test("worker runtime preserves queue and scheduler failures", async () => {
  const queueFailure = new Error("queue failed");
  const schedulerFailure = new Error("scheduler failed");

  await assert.rejects(
    runWorkerRuntime({
      federation: {
        startQueue: () => Promise.reject(queueFailure),
      },
      contextData: undefined,
      runScheduler: () => Promise.reject(schedulerFailure),
    }),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [queueFailure, schedulerFailure]);
      return true;
    },
  );
});
