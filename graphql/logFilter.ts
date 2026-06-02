import type { LogRecord } from "@logtape/logtape";

// Reads a string-typed own property off an unknown object, or `""` if absent or
// non-string. Used to inspect `Error`-like values without assuming a class.
function stringProp(object: object, key: string): string {
  const value = (object as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/**
 * Heuristically decides whether `error` (the value Fedify attaches as the
 * `error` property of a federation failure log) is a failure to reach or fetch
 * from a remote peer, as opposed to an application-side bug.
 *
 * Biased toward `false`: only a positive remote-fetch signal returns `true`, so
 * unknown or app-side errors are treated as actionable and kept. This matters
 * for inbox processing, where the same log wraps both remote-driven failures
 * and exceptions thrown by our own inbox listeners.
 */
export function isRemoteTransportError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = stringProp(error, "name");
  const message = stringProp(error, "message");
  // Fedify's document loader throws `FetchError` when a dereferenced remote
  // document responds non-OK (e.g. a referenced object 404s during processing).
  if (name === "FetchError") return true;
  // Deno's `fetch` raises a `TypeError` whose message begins with "error
  // sending request for url (...)" for transport failures: DNS resolution, TLS,
  // and connection errors (the GRAPHQL-27 family: "dns error: ...", "received
  // fatal alert: ...). Require the `TypeError` name as well so an unrelated
  // wrapper/app error that happens to start with that text is still kept.
  if (
    name === "TypeError" &&
    message.startsWith("error sending request for url")
  ) {
    return true;
  }
  return false;
}

/**
 * Decides whether a LogTape record is a routine, remote-peer-driven federation
 * failure that Fedify logs at `error` level and then retries (so a single bad
 * peer logs the same error many times). These are inherent to federation, not
 * actionable hackers.pub bugs, so they should not be forwarded to Sentry as
 * issues (GRAPHQL-18 came from a remote 404; GRAPHQL-27 from 217 retries to a
 * dead inbox; GRAPHQL-19 from a 403 on a remote followers collection). We match
 * the known-routine ones narrowly and let genuinely actionable fedify errors
 * through.
 *
 * The matched fields (`status`, `category`, `rawMessage`, and the `error`
 * object, which `@logtape/redaction` passes through untouched as a built-in
 * object) survive redaction unchanged, so this predicate reads the same values
 * whether it runs before or after redaction.
 */
export function isRoutineFederationError(record: LogRecord): boolean {
  const { category, properties, rawMessage } = record;
  if (category[0] !== "fedify") return false;
  const message = typeof rawMessage === "string"
    ? rawMessage
    : rawMessage[0] ?? "";

  // docloader: a remote returned an HTTP error status while we dereferenced a
  // document (a deleted note 404/410, a peer 5xx, ...). docloader's status-less
  // `error` logs (SSRF-blocked "Disallowed private URL", redirect loops, too
  // many redirections) have no numeric `status` and still reach Sentry, since
  // those can signal a real problem.
  if (category[1] === "runtime" && category[2] === "docloader") {
    const status = properties.status;
    return typeof status === "number" && status >= 400;
  }

  // vocab: a getter called with `suppressError: true` caught a dereference
  // failure, logged it here at `error`, and returned `null`, so the caller
  // (e.g. persistActor reading a remote `followers` count) already handled it.
  // Every `["fedify", "vocab"]` error log lives in a `suppressError` branch, so
  // none can hide a hackers.pub bug. Drop the fetch failures whose wrapped
  // error is a remote fetch/transport failure; "Failed to parse ..." (malformed
  // remote JSON-LD) is kept as a thinner signal.
  if (category[1] === "vocab") {
    return message.startsWith("Failed to fetch") &&
      isRemoteTransportError(properties.error);
  }

  if (category[1] === "federation") {
    // outbox: every send is just a `fetch` to a remote inbox, so a delivery
    // failure is always remote/transport-caused (DNS gone, TLS fatal alert,
    // connection refused, ...). The other outbox `error` logs ("An unexpected
    // error occurred in ... handler") have a different prefix and still reach
    // Sentry.
    if (category[2] === "outbox") {
      return message.startsWith("Failed to send activity");
    }
    // inbox: "Failed to process the incoming activity" wraps whatever the
    // application inbox listener threw, which may be a remote-peer failure
    // (drop) OR a hackers.pub bug (keep). Only drop when the wrapped error is
    // demonstrably a remote fetch/transport failure; anything else (including
    // unknown errors) is kept so genuine listener bugs still reach Sentry.
    if (category[2] === "inbox") {
      return message.startsWith("Failed to process the incoming activity") &&
        isRemoteTransportError(properties.error);
    }
  }
  return false;
}
