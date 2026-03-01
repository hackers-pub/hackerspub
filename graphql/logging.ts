import { ansiColorFormatter, configure, getStreamSink } from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";
import { AsyncLocalStorage } from "node:async_hooks";

const LOG_QUERY = Deno.env.get("LOG_QUERY")?.toLowerCase() === "true";
const LOG_FEDIFY = Deno.env.get("LOG_FEDIFY")?.toLowerCase() === "true";

function redactDeviceToken(value: unknown): unknown {
  if (typeof value !== "string") return "[REDACTED]";
  const visibleChars = 8;
  if (value.length <= visibleChars) return "[REDACTED]";
  return `${"*".repeat(value.length - visibleChars)}${
    value.slice(-visibleChars)
  }`;
}

await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks: {
    console: redactByField(
      getStreamSink(Deno.stderr.writable, {
        formatter: ansiColorFormatter,
      }),
      {
        fieldPatterns: [/device[-_]?token/i],
        action: redactDeviceToken,
      },
    ),
  },
  loggers: [
    {
      category: "hackerspub",
      lowestLevel: "debug",
      sinks: ["console"],
    },
    {
      category: "drizzle-orm",
      lowestLevel: LOG_QUERY ? "trace" : "info",
      sinks: ["console"],
    },
    {
      category: "fedify",
      lowestLevel: LOG_FEDIFY ? "trace" : "info",
      sinks: ["console"],
    },
    {
      category: "vertana",
      lowestLevel: "info",
      sinks: ["console"],
    },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console"],
    },
  ],
});
