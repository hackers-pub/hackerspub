import "./logging.ts";
import { getLogger } from "@logtape/logtape";
import {
  denoCronIntegration,
  getDefaultIntegrations,
  init,
} from "@sentry/deno";

const logger = getLogger(["hackerspub", "sentry"]);

const SENTRY_DSN = Deno.env.get("SENTRY_DSN");

if (SENTRY_DSN != null) {
  init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 1.0,
    integrations: [
      ...getDefaultIntegrations({}),
      denoCronIntegration(),
    ],
  });
  logger.debug("Sentry initialized.", { dsn: SENTRY_DSN });
} else {
  logger.debug(
    "Sentry not initialized: missing SENTRY_DSN environment variable.",
  );
}
