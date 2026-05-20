import { getFileSink } from "@logtape/file";
import {
  ansiColorFormatter,
  configure,
  getStreamSink,
  jsonLinesFormatter,
  type Sink,
} from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";
import { getSentrySink } from "@logtape/sentry";
import { AsyncLocalStorage } from "node:async_hooks";

const LOG_QUERY = Deno.env.get("LOG_QUERY")?.toLowerCase() === "true";
const LOG_FEDIFY = Deno.env.get("LOG_FEDIFY")?.toLowerCase() === "true";
const LOG_FILE = Deno.env.get("LOG_FILE") ?? null;

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
if (sentryEnabled) {
  sinks.sentry = getSentrySink({
    // Surface lower-level records as Sentry breadcrumbs so they show up
    // alongside captured events for context.
    enableBreadcrumbs: true,
    // (Logs API forwarding — `enableLogs: true` — is documented on the
    // LogTape site but not yet shipped in the latest stable
    // @logtape/sentry 2.0.6; only 2.1.0-dev.* prereleases include it.
    // Add it here once 2.1.0 lands as a stable release.)
  });
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
