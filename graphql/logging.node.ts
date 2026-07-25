import * as Sentry from "@sentry/node-sdk";
import process from "node:process";
import { configureLogging } from "./logging-config.ts";
import { createNonClosingWebWritable } from "./non-closing-writable.node.ts";

await configureLogging({
  environment: { ...process.env },
  stderr: createNonClosingWebWritable(process.stderr),
  sentry: Sentry,
});
