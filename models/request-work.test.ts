import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  drainRequestWork,
  getRequestWorkOutcome,
  hasRequestWork,
  reportRequestDependencyInterruption,
  reportRequestWorkFailure,
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

test("nested work shares the first failure before abort and keeps soft interruption local", async () => {
  const abort = new AbortController();
  const failure = { kind: "overload" as const, error: new Error("full") };
  let reports = 0;
  await runWithRequestWork(
    abort.signal,
    async () => {
      const outcome = getRequestWorkOutcome();
      assert.equal(outcome.dependencyInterrupted, false);
      await runWithRequestWork(abort.signal, async () => {
        reportRequestDependencyInterruption(
          new Error("optional lookup timed out"),
        );
        assert.equal(getRequestWorkOutcome(), outcome);
        assert.equal(abort.signal.aborted, false);
        reportRequestWorkFailure(failure);
        reportRequestWorkFailure({
          kind: "timeout",
          error: new Error("later"),
        });
      });
      assert.equal(outcome.hardFailure, failure);
      assert.equal(outcome.dependencyInterrupted, true);
    },
    {
      onFailure(value) {
        assert.equal(getRequestWorkOutcome().hardFailure, failure);
        assert.equal(value, failure);
        reports++;
        abort.abort(value.error);
      },
    },
  );
  assert.equal(reports, 1);
  assert.deepEqual(getRequestWorkOutcome(), { dependencyInterrupted: false });
  await runWithRequestWork(new AbortController().signal, async () => {
    assert.deepEqual(getRequestWorkOutcome(), { dependencyInterrupted: false });
  });
});

test("concurrent request outcomes remain isolated while a child drains", async () => {
  const pending = Promise.withResolvers<void>();
  const childEntered = Promise.withResolvers<void>();
  const first = runWithRequestWork(new AbortController().signal, async () => {
    await runWithRequestWork(new AbortController().signal, async () => {
      trackRequestWork(pending.promise);
      reportRequestDependencyInterruption(new Error("local"));
      childEntered.resolve();
    });
    assert.equal(getRequestWorkOutcome().dependencyInterrupted, true);
  });
  await childEntered.promise;
  await runWithRequestWork(new AbortController().signal, async () => {
    assert.deepEqual(getRequestWorkOutcome(), { dependencyInterrupted: false });
  });
  pending.resolve();
  await first;
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
