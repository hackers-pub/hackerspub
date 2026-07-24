// Preload this module with Node's `--import` flag. Sentry must initialize
// before node:http, GraphQL Yoga, or Fedify are imported so its HTTP request
// isolation and OpenTelemetry provider cover the entire API process.
import { getLogger } from "@logtape/logtape";
import * as Sentry from "@sentry/node-sdk";
import process from "node:process";
import metadata from "./deno.json" with { type: "json" };
import { reportUnhandledRejection } from "./unhandled-rejection.ts";

const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    release: metadata.version,
    enableLogs: true,
    sendDefaultPii: true,
    tracesSampleRate: 1.0,
    integrations: (defaultIntegrations) => [
      // The application classifies detached remote-peer failures itself.
      // Keeping the SDK handler as well would capture application rejections
      // twice and report routine federation transport failures.
      ...defaultIntegrations.filter(
        (integration) => integration.name !== "OnUnhandledRejection",
      ),
      Sentry.vercelAIIntegration(),
    ],
  });
}

process.on("unhandledRejection", (reason) => {
  reportUnhandledRejection(
    reason,
    getLogger(["hackerspub", "graphql"]),
    Sentry,
  );
});
