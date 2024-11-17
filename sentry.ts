import {
  denoCronIntegration,
  getDefaultIntegrations,
  init,
} from "@sentry/deno";

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
}
