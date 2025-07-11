import { ansiColorFormatter, configure, getStreamSink } from "@logtape/logtape";
import { AsyncLocalStorage } from "node:async_hooks";

const LOG_QUERY = Deno.env.get("LOG_QUERY")?.toLowerCase() === "true";

await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks: {
    console: getStreamSink(Deno.stderr.writable, {
      formatter: ansiColorFormatter,
    }),
  },
  loggers: [
    {
      category: "hackerspub",
      lowestLevel: "trace",
      sinks: ["console"],
    },
    {
      category: "drizzle-orm",
      lowestLevel: LOG_QUERY ? "trace" : "info",
      sinks: ["console"],
    },
    { category: "fedify", lowestLevel: "info", sinks: ["console"] },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console"],
    },
  ],
});
