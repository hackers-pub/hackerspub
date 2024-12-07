import { AsyncLocalStorage } from "node:async_hooks";
import {
  ansiColorFormatter,
  configure,
  getStreamSink,
  withFilter,
} from "@logtape/logtape";
import { getSentrySink } from "@logtape/sentry";
import { client } from "./sentry.ts";

await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks: {
    console: getStreamSink(Deno.stderr.writable, {
      formatter: ansiColorFormatter,
    }),
    sentry: withFilter(
      // @ts-ignore: client is assignable to type 'Client'.
      getSentrySink(client),
      (record) => record.level === "debug" || record.level === "info",
    ),
  },
  loggers: [
    {
      category: "hackerspub",
      lowestLevel: "debug",
      sinks: ["console", "sentry"],
    },
    { category: "drizzle-orm", lowestLevel: "debug", sinks: ["console"] },
    { category: "fedify", lowestLevel: "info", sinks: ["console", "sentry"] },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console", "sentry"],
    },
  ],
});
