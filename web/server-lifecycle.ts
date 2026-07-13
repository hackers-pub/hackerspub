export async function runFreshServerUntilAborted(
  startServer: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  await startServer(signal);

  // Fresh's listen() promise resolves after Deno.serve() starts, not when the
  // server stops. Keep the lifecycle pending so queue coordination does not
  // mistake successful startup for shutdown.
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
