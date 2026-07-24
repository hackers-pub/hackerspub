export type Cleanup = () => Promise<unknown> | unknown;

export async function closeSequentially(
  cleanups: readonly Cleanup[],
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
    throw new AggregateError(errors, "Failed to close GraphQL API resources.");
  }
}

export function combineRuntimeAndCloseErrors(
  runtimeError: unknown,
  closeError: unknown,
): unknown {
  if (runtimeError == null) return closeError;
  if (closeError == null) return runtimeError;
  return new AggregateError(
    [runtimeError, closeError],
    "The GraphQL API failed and its resources could not be closed.",
  );
}
