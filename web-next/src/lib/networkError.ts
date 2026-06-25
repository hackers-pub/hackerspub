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
    message.includes(
      "request cannot be constructed from a url that includes credentials",
    ) ||
    message.includes("load failed") ||
    message.includes("networkerror") ||
    message.includes("network request failed");
}

// Returns true when a full page reload is more likely to recover the app than
// a soft ErrorBoundary reset. Three cases warrant a reload:
//
//  1. Network errors: Relay's auto-retry budget is already exhausted by the
//     time the error reaches the boundary. A soft reset remounts the same
//     component tree with the same cached PreloadedQuery (still in error state),
//     so the boundary catches the same error again immediately. A reload fetches
//     fresh data from scratch.
//
//  2. Stale JS chunks after a deploy: Vite's `vite:preloadError` handler in
//     entry-client.tsx does a reload on the first hit, but a 10-second guard
//     prevents a second reload if the error recurs immediately. If that guard
//     fires and the error reaches the boundary, soft reset just retries the
//     same broken dynamic import.
//
//  3. SolidJS internal errors (minified in production): These indicate a
//     reactive invariant violation (e.g. hydration mismatch, signal read
//     outside an owner). The SolidJS reactive graph may be in a partially
//     corrupt state; remounting a subtree does not repair it. A reload gives
//     a clean reactive root.
export function shouldReloadOnError(error: unknown): boolean {
  if (isNetworkError(error)) return true;
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return msg.includes("dynamically imported module") ||
    msg.toLowerCase().includes("minified exception");
}
