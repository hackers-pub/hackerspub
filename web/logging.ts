import { getFileSink } from "@logtape/file";
import {
  ansiColorFormatter,
  configure,
  getStreamSink,
  jsonLinesFormatter,
} from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";
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

const redactOptions = {
  fieldPatterns: [/^(?:apns[-_]?)?device[-_]?token$/i],
  action: redactDeviceToken,
};
const sinks = {
  console: redactByField(
    getStreamSink(Deno.stderr.writable, { formatter: ansiColorFormatter }),
    redactOptions,
  ),
  ...(LOG_FILE != null
    ? {
      file: redactByField(
        getFileSink(LOG_FILE, { formatter: jsonLinesFormatter }),
        redactOptions,
      ),
    }
    : {}),
};
const allSinks = ["console", ...(LOG_FILE != null ? ["file"] : [])];

await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks,
  loggers: [
    {
      category: "hackerspub",
      lowestLevel: "trace",
      sinks: allSinks,
    },
    {
      category: "drizzle-orm",
      lowestLevel: LOG_QUERY ? "trace" : "info",
      sinks: allSinks,
    },
    {
      category: "fedify",
      lowestLevel: LOG_FEDIFY ? "trace" : "info",
      sinks: allSinks,
    },
    {
      category: "vertana",
      lowestLevel: "info",
      sinks: allSinks,
    },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: allSinks,
    },
  ],
});
