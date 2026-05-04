/**
 * Polls `predicate` every 50 ms until it resolves to `true` or
 * `timeoutMs` elapses.  Used by tests that observe state which a
 * background promise eventually mutates (translation completion,
 * placeholder reset, summary cleanup, etc.) without exposing that
 * promise to the test.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for async background state after ${timeoutMs}ms`,
  );
}
