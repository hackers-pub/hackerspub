export type Cleanup = () => Promise<unknown> | unknown;

export async function closeWithDeadline(
  cleanup: Cleanup,
  timeoutMilliseconds: number,
  timeoutMessage: string,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(timeoutMessage)),
      timeoutMilliseconds,
    );
  });
  try {
    await Promise.race([Promise.resolve().then(cleanup), timeout]);
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

export async function closeSequentially(
  cleanups: readonly Cleanup[],
  aggregateMessage = "Failed to close GraphQL API resources.",
): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, aggregateMessage);
  }
}

export function combineRuntimeAndCloseErrors(
  runtimeError: unknown,
  closeError: unknown,
  aggregateMessage = "The GraphQL API failed and its resources could not be closed.",
): unknown {
  if (runtimeError == null) return closeError;
  if (closeError == null) return runtimeError;
  return new AggregateError([runtimeError, closeError], aggregateMessage);
}
