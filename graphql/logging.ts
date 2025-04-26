import { ansiColorFormatter, configure, getStreamSink } from "@logtape/logtape";
import { AsyncLocalStorage } from "node:async_hooks";

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
      lowestLevel: "debug",
      sinks: ["console"],
    },
    { category: "drizzle-orm", lowestLevel: "info", sinks: ["console"] },
    { category: "fedify", lowestLevel: "info", sinks: ["console"] },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console"],
    },
  ],
});
