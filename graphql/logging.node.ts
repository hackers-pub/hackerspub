import * as Sentry from "@sentry/node-sdk";
import process from "node:process";
import { Writable } from "node:stream";
import { configureLogging } from "./logging-config.ts";

await configureLogging({
  environment: { ...process.env },
  stderr: Writable.toWeb(process.stderr) as WritableStream<Uint8Array>,
  sentry: Sentry,
});
