import * as Sentry from "@sentry/deno";
import { configureLogging } from "./logging-config.ts";

await configureLogging({
  environment: Deno.env.toObject(),
  stderr: Deno.stderr.writable,
  sentry: Sentry,
});
