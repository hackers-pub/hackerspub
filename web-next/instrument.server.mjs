// Server-side Sentry initialization. Loaded via `node --import` before the
// Nitro entry runs (see `prod:web-next` in mise.toml). Skips init when
// SENTRY_DSN is unset so local development and builds without a DSN
// configured stay quiet.
import * as Sentry from "@sentry/solidstart";
import nodeProcess from "node:process";
import packageJson from "./package.json" with { type: "json" };

const TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME = "TransientUpstreamGraphQLError";
const TRANSIENT_UPSTREAM_GRAPHQL_ERROR_MESSAGE_PREFIX =
  "fetch failed: GraphQL upstream returned ";

function isTransientUpstreamGraphQLErrorEvent(event, hint) {
  if (
    hint?.originalException instanceof Error &&
    (hint.originalException.name === TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME ||
      hint.originalException.message.startsWith(
        TRANSIENT_UPSTREAM_GRAPHQL_ERROR_MESSAGE_PREFIX,
      ))
  ) {
    return true;
  }

  return (
    event.exception?.values?.some(
      (value) =>
        value.type === TRANSIENT_UPSTREAM_GRAPHQL_ERROR_NAME ||
        value.value?.startsWith(
          TRANSIENT_UPSTREAM_GRAPHQL_ERROR_MESSAGE_PREFIX,
        ),
    ) ?? false
  );
}

if (nodeProcess.env.SENTRY_DSN) {
  Sentry.init({
    dsn: nodeProcess.env.SENTRY_DSN,
    // Tag events with the same release identifier the client and the
    // Sentry Vite plugin use, so Sentry can match the source maps it
    // received during the build with the stack traces it receives at
    // runtime. See entry-client.tsx and vite.config.ts for the matching
    // configuration.
    release: packageJson.version,
    sendDefaultPii: true,
    beforeSend(event, hint) {
      if (isTransientUpstreamGraphQLErrorEvent(event, hint)) return null;
      return event;
    },
  });
}
