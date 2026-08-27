import assert from "node:assert";
import test from "node:test";
import { createArticleViewEligibilityGate } from "./articleViewEligibility.ts";

test("article view eligibility requires one continuous interval", () => {
  const callbacks: Array<() => void> = [];
  let cancelled = 0;
  let counted = 0;
  const timer = {} as ReturnType<typeof setTimeout>;
  const gate = createArticleViewEligibilityGate({
    delayMilliseconds: 2_000,
    onEligible: () => counted++,
    schedule: (scheduled, delay) => {
      assert.equal(delay, 2_000);
      callbacks.push(scheduled);
      return timer;
    },
    cancel: () => cancelled++,
  });

  gate.update(true);
  gate.update(false);
  assert.equal(cancelled, 1);
  assert.equal(counted, 0);

  // Recreate the gate to verify the normal restart path with a fresh timer.
  const restarted = createArticleViewEligibilityGate({
    delayMilliseconds: 2_000,
    onEligible: () => counted++,
    schedule: (scheduled) => {
      callbacks.push(scheduled);
      return timer;
    },
    cancel: () => undefined,
  });
  restarted.update(true);
  restarted.update(false);
  restarted.update(true);
  callbacks.at(-1)!();
  assert.equal(counted, 1);
  restarted.update(true);
  assert.equal(counted, 1);
});

test("disposing article view eligibility cancels pending work", () => {
  let cancelled = false;
  let counted = 0;
  const timer = {} as ReturnType<typeof setTimeout>;
  const gate = createArticleViewEligibilityGate({
    delayMilliseconds: 2_000,
    onEligible: () => counted++,
    schedule: () => timer,
    cancel: () => {
      cancelled = true;
    },
  });

  gate.update(true);
  gate.dispose();
  assert.equal(cancelled, true);
  assert.equal(counted, 0);
});
