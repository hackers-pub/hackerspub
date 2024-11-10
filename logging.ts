import { AsyncLocalStorage } from "node:async_hooks";
import { configure, getConsoleSink } from "@logtape/logtape";

await configure({
  contextLocalStorage: new AsyncLocalStorage(),
  sinks: {
    console: getConsoleSink(),
  },
  loggers: [
    { category: "hackerspub", level: "debug", sinks: ["console"] },
    { category: "fedify", level: "info", sinks: ["console"] },
    { category: ["logtape", "meta"], level: "warning", sinks: ["console"] },
  ],
});
