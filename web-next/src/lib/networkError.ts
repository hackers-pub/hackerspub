// Browsers spell the "no network reached the server" condition differently:
// Chrome/Edge "Failed to fetch", Safari "Load failed", Firefox "NetworkError
// when attempting to fetch resource". They all surface as `TypeError`, so
// we narrow on the constructor first and then on the message to avoid
// matching genuine programmer errors (e.g. a `TypeError` thrown from inside
// a resolver) that happen to land on the same code path.
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const message = error.message.toLowerCase();
  return message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("load failed") ||
    message.includes("networkerror") ||
    message.includes("network request failed");
}
