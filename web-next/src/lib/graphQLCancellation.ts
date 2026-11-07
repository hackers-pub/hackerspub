const CANCELLATION_NAME = "GraphQLRequestCancelledError";

export type GraphQLCancellationSource = "inbound" | "disposal";

/** Deliberate cancellation, independent of the caller's arbitrary reason. */
export class GraphQLRequestCancelledError extends Error {
  readonly source: GraphQLCancellationSource;

  constructor(source: GraphQLCancellationSource, reason?: unknown) {
    super(`GraphQL request cancelled (${source})`, { cause: reason });
    this.name = CANCELLATION_NAME;
    this.source = source;
  }
}

export function isGraphQLRequestCancelledError(error: unknown): boolean {
  // The source imported by --import instrumentation and Nitro's bundled
  // transport have different constructors. Use the dedicated error name.
  return error instanceof Error && error.name === CANCELLATION_NAME;
}

export function isGraphQLCancellationEvent(
  event: { exception?: { values?: readonly { type?: string }[] } },
  hint?: { originalException?: unknown },
): boolean {
  return (
    isGraphQLRequestCancelledError(hint?.originalException) ||
    (event.exception?.values?.some(
      (value) => value.type === CANCELLATION_NAME,
    ) ??
      false)
  );
}
