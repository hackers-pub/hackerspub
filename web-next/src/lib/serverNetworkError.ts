const networkErrorCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);

function hasNetworkCause(error: unknown, seen: Set<object>): boolean {
  if (typeof error !== "object" || error === null || seen.has(error)) {
    return false;
  }
  seen.add(error);

  if (
    "code" in error &&
    typeof error.code === "string" &&
    networkErrorCodes.has(error.code)
  ) {
    return true;
  }
  if (error instanceof AggregateError) {
    return error.errors.some((nested) => hasNetworkCause(nested, seen));
  }
  return "cause" in error && hasNetworkCause(error.cause, seen);
}

export function isServerNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    error instanceof TypeError &&
    (error.message === "fetch failed" || error.message === "terminated")
  ) {
    return hasNetworkCause(error, new Set());
  }
  return false;
}
