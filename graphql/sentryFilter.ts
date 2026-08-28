function stringProperty(value: object, key: string): string {
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : "";
}

/**
 * Identifies the error Node emits when a peer closes an HTTP request before
 * its body has finished arriving. This is a client cancellation, not a server
 * failure. Match the internal stack narrowly so application errors with the
 * same short message still reach Sentry.
 */
export function isIncomingRequestAbort(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (stringProperty(error, "message") !== "aborted") return false;
  const stack = stringProperty(error, "stack");
  return (
    stack.includes("abortIncoming (node:_http_server:") &&
    stack.includes("socketOnClose (node:_http_server:")
  );
}
