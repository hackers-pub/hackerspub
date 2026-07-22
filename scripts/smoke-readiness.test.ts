import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitUntil } from "./smoke-readiness.ts";

Deno.test("waitUntil bounds a stalled readiness check to its deadline", async () => {
  let signal: AbortSignal | undefined;
  const started = performance.now();

  await assertRejects(
    () =>
      waitUntil(
        "a stalled service",
        (probeSignal) => {
          signal = probeSignal;
          return new Promise<boolean>(() => {});
        },
        25,
      ),
    Error,
    "Timed out waiting for a stalled service.",
  );

  assert(signal?.aborted);
  assert(
    performance.now() - started < 500,
    "a stalled readiness check should not outlive its deadline",
  );
});

Deno.test("waitUntil retries readiness checks until one succeeds", async () => {
  let attempts = 0;

  await waitUntil(
    "a starting service",
    async () => ++attempts === 2,
    1_000,
    1,
  );

  assertEquals(attempts, 2);
});
