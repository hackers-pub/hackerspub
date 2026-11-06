import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  drainRequestWork,
  hasRequestWork,
  runWithRequestWork,
  throwIfRequestWorkAborted,
  trackRequestWork,
} from "./request-work.ts";

test("request work retains abandoned raw work and preserves the callback error", async () => {
  const underlying = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const failure = new Error("execution failed");
  let finished = false;
  const execution = runWithRequestWork(
    new AbortController().signal,
    async () => {
      trackRequestWork(underlying.promise);
      entered.resolve();
      throw failure;
    },
  );
  void execution.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await entered.promise;
  await setImmediate();
  assert.equal(finished, false);
  underlying.reject(new Error("abandoned branch failed"));
  await assert.rejects(execution, (error) => error === failure);
});

test("request drain includes later continuations and newly registered work", async () => {
  const first = Promise.withResolvers<void>();
  const nested = Promise.withResolvers<void>();
  const nestedStarted = Promise.withResolvers<void>();
  let finished = false;
  const execution = runWithRequestWork(
    new AbortController().signal,
    async () => {
      const work = trackRequestWork(first.promise);
      void work.then(() =>
        Promise.resolve().then(() => {
          trackRequestWork(nested.promise);
          nestedStarted.resolve();
        }),
      );
      return "result";
    },
  ).then((result) => {
    finished = true;
    return result;
  });
  first.resolve();
  await nestedStarted.promise;
  await setImmediate();
  assert.equal(finished, false);
  nested.resolve();
  assert.equal(await execution, "result");
});

test("request work scopes isolate cancellation and pending work", async () => {
  const cancelled = new AbortController();
  const underlying = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const execution = runWithRequestWork(cancelled.signal, async () => {
    trackRequestWork(underlying.promise);
    entered.resolve();
    await underlying.promise;
    throwIfRequestWorkAborted();
  });
  await entered.promise;
  cancelled.abort();
  assert.equal(
    await runWithRequestWork(new AbortController().signal, async () => {
      throwIfRequestWorkAborted();
      assert.equal(hasRequestWork(), true);
      return "independent";
    }),
    "independent",
  );
  underlying.resolve();
  await assert.rejects(execution, { name: "AbortError" });
  assert.equal(hasRequestWork(), false);
});

test("already-aborted work never invokes the callback and unscoped drain is inert", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  let called = false;
  await assert.rejects(
    runWithRequestWork(cancelled.signal, async () => {
      called = true;
    }),
    { name: "AbortError" },
  );
  assert.equal(called, false);
  throwIfRequestWorkAborted();
  await drainRequestWork();
});
