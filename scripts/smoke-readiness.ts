export type ReadinessCheck = (signal: AbortSignal) => Promise<boolean>;

export async function waitUntil(
  description: string,
  check: ReadinessCheck,
  timeoutMilliseconds = 60_000,
  retryIntervalMilliseconds = 500,
): Promise<void> {
  const deadline = performance.now() + timeoutMilliseconds;
  while (performance.now() < deadline) {
    const remainingMilliseconds = Math.max(
      1,
      Math.ceil(deadline - performance.now()),
    );
    const signal = AbortSignal.timeout(remainingMilliseconds);
    let abortHandler: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortHandler = () => reject(signal.reason);
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    });

    try {
      if (
        await Promise.race([
          Promise.resolve().then(() => check(signal)),
          aborted,
        ])
      ) {
        return;
      }
    } catch {
      // The service can refuse connections while it is still starting.
    } finally {
      if (abortHandler != null) {
        signal.removeEventListener("abort", abortHandler);
      }
    }

    const delayMilliseconds = Math.min(
      retryIntervalMilliseconds,
      deadline - performance.now(),
    );
    if (delayMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    }
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
