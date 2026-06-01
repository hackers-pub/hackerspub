import { getFileSink } from "@logtape/file";
import {
  ansiColorFormatter,
  configure,
  getStreamSink,
  jsonLinesFormatter,
  type LogRecord,
  type Sink,
  withFilter,
} from "@logtape/logtape";
import {
  createHmacPseudonymizer,
  redactByField,
  redactByFieldAsync,
} from "@logtape/redaction";
import { getSentrySink } from "@logtape/sentry";
import * as Sentry from "@sentry/deno";
import { AsyncLocalStorage } from "node:async_hooks";

const LOG_QUERY = Deno.env.get("LOG_QUERY")?.toLowerCase() === "true";
const LOG_FEDIFY = Deno.env.get("LOG_FEDIFY")?.toLowerCase() === "true";
const LOG_FILE = Deno.env.get("LOG_FILE") ?? null;
// HMAC key for pseudonymizing sensitive fields on the Sentry sink (see below).
// Reuses the app's master secret; only its one-way HMAC pseudonyms ever leave
// the box, never the secret itself. `|| null` folds a blank value (e.g. Docker
// Compose substituting an unset variable as `""`) into the missing case, since
// `createHmacPseudonymizer` throws on a zero-length key.
const SECRET_KEY = Deno.env.get("SECRET_KEY") || null;

function redactDeviceToken(value: unknown): unknown {
  if (typeof value !== "string") return "[REDACTED]";
  const visibleChars = 8;
  if (value.length <= visibleChars) return "[REDACTED]";
  return `${"*".repeat(value.length - visibleChars)}${
    value.slice(-visibleChars)
  }`;
}

// Forward LogTape `error`/`fatal` records to Sentry as captured events
// (the sink's default level filter), so server-side issues that get
// logged through getLogger(...) end up in the same dashboard as
// uncaught exceptions. Skipped when SENTRY_DSN is unset (Sentry isn't
// initialized either, see ./instrument.ts), so local dev stays quiet.
const sentryEnabled = Deno.env.get("SENTRY_DSN") != null;
const sinks: Record<string, Sink> = {
  console: redactByField(
    getStreamSink(Deno.stderr.writable, {
      formatter: ansiColorFormatter,
    }),
    {
      fieldPatterns: [/^(?:apns[-_]?)?device[-_]?token$/i],
      action: redactDeviceToken,
    },
  ),
};
// Field patterns whose values must never reach Sentry in the clear: the
// sign-in / sign-up `tokenData` (token + OTP code), session/bearer tokens, web
// push keys (`p256dh`), and FCM/APNS device tokens (matched by `/token/i`).
const SENTRY_REDACT_FIELDS = [
  /token/i,
  /code/i,
  /secret/i,
  /key/i,
  /password/i,
  /authorization/i,
  /p256dh/i,
  /auth/i,
];

// Fedify's document loader logs every non-OK HTTP response from a remote peer
// (a deleted note returns `404`/`410`, a peer is briefly `5xx`, a relay `429`s
// us, ...) at `error` level under `["fedify", "runtime", "docloader"]`, then
// throws. These fetch failures are inherent to federation, not actionable bugs,
// so routing them to Sentry just produces escalating noise (an inbound 404
// produced the GRAPHQL-18 issue). We drop only the records that carry an HTTP
// error `status` (>= 400); docloader's other `error` logs (the SSRF-blocked
// "Disallowed private URL", redirect loops, too many redirections) have no
// numeric `status` and still reach Sentry, since those can signal a real
// problem. `status` is not a redacted field, so this predicate reads the same
// value whether it runs before or after redaction.
function isRoutineFederationFetchFailure(record: LogRecord): boolean {
  const { category, properties } = record;
  if (
    category.length < 3 ||
    category[0] !== "fedify" ||
    category[1] !== "runtime" ||
    category[2] !== "docloader"
  ) {
    return false;
  }
  const status = properties.status;
  return typeof status === "number" && status >= 400;
}

if (sentryEnabled) {
  // This sink used to be a no-op (see the version note below), so activating it
  // newly exposes whatever we log to a third party: most importantly the
  // sign-in / sign-up `tokenData` (token + OTP code) logged at debug, which
  // `enableBreadcrumbs` forwards as breadcrumbs. We redact the sensitive fields
  // before anything leaves; redaction is recursive and also rewrites matching
  // message placeholders, so a nested `{ token: { token, code } }` and the
  // `{token}` in its message both get masked.
  const sentrySink = getSentrySink({
    // Use the Sentry SDK namespace this server actually initialized
    // (@sentry/deno, backed by @sentry/core v10). Without this the sink falls
    // back to @logtape/sentry's own bundled @sentry/core (v9) globals, and
    // since Sentry stores the active client under a per-SDK-version carrier
    // (`globalThis.__SENTRY__[SDK_VERSION]`) the v9 lookup never finds the v10
    // client, so every capture is a silent no-op. (The `sentry` option landed
    // in @logtape/sentry 2.2.0; pinned to a 2.2.0-dev prerelease until it ships
    // stable.)
    sentry: Sentry,
    // Surface lower-level records as Sentry breadcrumbs so they show up
    // alongside captured events for context.
    enableBreadcrumbs: true,
  });
  // Drop routine remote-fetch failures (see `isRoutineFederationFetchFailure`)
  // before they reach Sentry, as captured events and as breadcrumbs alike. We
  // filter the raw sink here, then let redaction wrap the result below, so the
  // outermost sink stays the redaction wrapper and its `Symbol.asyncDispose`
  // (which flushes the async pseudonymizer queue on shutdown) is preserved;
  // `withFilter` returns a bare function that would otherwise drop it.
  const filteredSentrySink = withFilter(
    sentrySink,
    (record) => !isRoutineFederationFetchFailure(record),
  );
  // Pseudonymize rather than blank out: a keyed HMAC keeps the raw secret out
  // of Sentry while mapping equal inputs to equal pseudonyms, so the same
  // device token / sign-in token still correlates across events. HMAC is
  // one-way and keyed on the app's SECRET_KEY, so a pseudonym can't be reversed
  // (or brute-forced for small-input-space values like OTP codes) without that
  // secret. If SECRET_KEY is unset or blank we fall back to a hard `[REDACTED]`
  // so a missing key can never cause a leak (only lose cross-event correlation).
  if (SECRET_KEY == null) {
    sinks.sentry = redactByField(filteredSentrySink, {
      fieldPatterns: SENTRY_REDACT_FIELDS,
      action: () => "[REDACTED]",
    });
  } else {
    const pseudonymize = await createHmacPseudonymizer({ key: SECRET_KEY });
    sinks.sentry = redactByFieldAsync(filteredSentrySink, {
      fieldPatterns: SENTRY_REDACT_FIELDS,
      action: pseudonymize,
    });
  }
}
if (LOG_FILE != null) {
  sinks.file = redactByField(
    getFileSink(LOG_FILE, { formatter: jsonLinesFormatter }),
    {
      fieldPatterns: [/^(?:apns[-_]?)?device[-_]?token$/i],
      action: redactDeviceToken,
    },
  );
}
const loggerSinks = [
  "console",
  ...(sentryEnabled ? ["sentry"] : []),
  ...(LOG_FILE != null ? ["file"] : []),
];

await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks,
  loggers: [
    {
      category: "hackerspub",
      lowestLevel: "debug",
      sinks: loggerSinks,
    },
    {
      category: "drizzle-orm",
      lowestLevel: LOG_QUERY ? "trace" : "info",
      sinks: loggerSinks,
    },
    {
      category: "fedify",
      lowestLevel: LOG_FEDIFY ? "trace" : "info",
      sinks: loggerSinks,
    },
    {
      category: "vertana",
      lowestLevel: "info",
      sinks: loggerSinks,
    },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      // The Sentry sink itself logs through this category; routing it
      // back to Sentry would loop, so keep Sentry excluded here.
      // File sink is safe to include (no loop risk).
      sinks: ["console", ...(LOG_FILE != null ? ["file"] : [])],
    },
  ],
});
