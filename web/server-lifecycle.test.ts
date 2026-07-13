import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { runFreshServerUntilAborted } from "./server-lifecycle.ts";

Deno.test("Fresh server lifecycle remains pending until shutdown", async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let completed = false;

  const lifecycle = runFreshServerUntilAborted((signal) => {
    assertStrictEquals(signal, controller.signal);
    started.resolve();
    return Promise.resolve();
  }, controller.signal).then(() => {
    completed = true;
  });

  await started.promise;
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(completed, false);

  controller.abort();
  await lifecycle;
  assertEquals(completed, true);
});

Deno.test("Fresh server lifecycle propagates startup failures", async () => {
  const controller = new AbortController();

  await assertRejects(
    () =>
      runFreshServerUntilAborted(
        () => Promise.reject(new Error("Failed to start server")),
        controller.signal,
      ),
    Error,
    "Failed to start server",
  );
});
