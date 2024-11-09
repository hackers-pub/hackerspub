import { configure, getConsoleSink } from "@logtape/logtape";

await configure({
  sinks: {
    console: getConsoleSink(),
  },
  loggers: [
    { category: "hackerspub", level: "debug", sinks: ["console"] },
    { category: ["logtape", "meta"], level: "warning", sinks: ["console"] },
  ],
});
