export const TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME =
  "TransientUpstreamGraphQLError";
export const TRANSIENT_UPSTREAM_GRAPHQL_ERROR_MESSAGE_PREFIX =
  "fetch failed: GraphQL upstream returned ";

const TRANSIENT_UPSTREAM_STATUSES = new Set([502, 503, 504]);

export interface UpstreamErrorReportInput {
  status: number;
  responseText?: string;
  errors?: ReadonlyArray<unknown>;
}

export function shouldCaptureUpstreamError(
  input: UpstreamErrorReportInput,
): boolean {
  if (input.errors != null) return true;
  if (!TRANSIENT_UPSTREAM_STATUSES.has(input.status)) return true;
  if (input.responseText == null) return true;
  return input.responseText.trim() !== "";
}

export class TransientUpstreamGraphQLError extends TypeError {
  constructor(operationName: string | undefined, status: number) {
    super(
      `${TRANSIENT_UPSTREAM_GRAPHQL_ERROR_MESSAGE_PREFIX}${status} for ${
        operationName ?? "<unnamed>"
      }`,
    );
    this.name = TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME;
  }
}

export interface SentryExceptionValue {
  type?: string;
  value?: string;
}

export interface SentryEventLike {
  exception?: { values?: readonly SentryExceptionValue[] };
}

export interface SentryHintLike {
  originalException?: unknown;
}

export function isTransientUpstreamGraphQLErrorEvent(
  event: SentryEventLike,
  hint?: SentryHintLike,
): boolean {
  if (
    hint?.originalException instanceof Error &&
    (hint.originalException.name === TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME ||
      hint.originalException.message.startsWith(
        TRANSIENT_UPSTREAM_GRAPHQL_ERROR_MESSAGE_PREFIX,
      ))
  ) return true;

  return event.exception?.values?.some((value) =>
    value.type === TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME ||
    value.value?.startsWith(TRANSIENT_UPSTREAM_GRAPHQL_ERROR_MESSAGE_PREFIX)
  ) ?? false;
}
