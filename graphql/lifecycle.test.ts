import assert from "node:assert/strict";
import test from "node:test";
import {
  closeWithDeadline,
  closeSequentially,
  combineRuntimeAndCloseErrors,
} from "./lifecycle.ts";

test("closeWithDeadline keeps cleanup bounded", async () => {
  let cleaned = false;
  await closeWithDeadline(
    () => {
      cleaned = true;
    },
    10,
    "cleanup timed out",
  );
  assert.equal(cleaned, true);

  await assert.rejects(
    closeWithDeadline(
      () => new Promise(() => undefined),
      1,
      "cleanup timed out",
    ),
    /cleanup timed out/,
  );
});

test("closeSequentially preserves shutdown order", async () => {
  const order: string[] = [];
  await closeSequentially([
    () => order.push("http"),
    async () => {
      await Promise.resolve();
      order.push("adapter");
    },
    () => order.push("yoga"),
    () => order.push("resources"),
    () => order.push("logging"),
  ]);
  assert.deepEqual(order, ["http", "adapter", "yoga", "resources", "logging"]);
});

test("closeSequentially attempts every cleanup and aggregates failures", async () => {
  const first = new Error("first");
  const second = new Error("second");
  const attempted: number[] = [];

  await assert.rejects(
    closeSequentially([
      () => {
        attempted.push(1);
        throw first;
      },
      () => attempted.push(2),
      () => {
        attempted.push(3);
        throw second;
      },
    ]),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [first, second]);
      return true;
    },
  );
  assert.deepEqual(attempted, [1, 2, 3]);
});

test("runtime and shutdown errors retain both causes", () => {
  const runtime = new Error("runtime");
  const close = new Error("close");

  assert.strictEqual(combineRuntimeAndCloseErrors(runtime, undefined), runtime);
  assert.strictEqual(combineRuntimeAndCloseErrors(undefined, close), close);
  const combined = combineRuntimeAndCloseErrors(runtime, close);
  assert(combined instanceof AggregateError);
  assert.deepEqual(combined.errors, [runtime, close]);
});

test("lifecycle helpers support role-specific aggregate messages", async () => {
  await assert.rejects(
    closeSequentially(
      [
        () => {
          throw new Error("first");
        },
        () => {
          throw new Error("second");
        },
      ],
      "Failed to close worker resources.",
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.message, "Failed to close worker resources.");
      return true;
    },
  );

  const combined = combineRuntimeAndCloseErrors(
    new Error("runtime"),
    new Error("close"),
    "The worker failed.",
  );
  assert(combined instanceof AggregateError);
  assert.equal(combined.message, "The worker failed.");
});
