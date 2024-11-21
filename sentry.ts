import "./logging.ts";
import { getLogger } from "@logtape/logtape";
import { trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { Resource } from "@opentelemetry/resources";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  SEMRESATTRS_SERVICE_NAMESPACE,
} from "@opentelemetry/semantic-conventions";
import {
  SentryPropagator,
  SentrySampler,
  SentrySpanProcessor,
  setOpenTelemetryContextAsyncContextStrategy,
  setupEventContextTrace,
  wrapContextManagerClass,
} from "@sentry/opentelemetry";
import { getGlobalScope, setCurrentClient } from "@sentry/core";
import {
  denoCronIntegration,
  getClient,
  getDefaultIntegrations,
  init,
  SDK_VERSION,
} from "@sentry/deno";

const logger = getLogger(["hackerspub", "sentry"]);

const SENTRY_DSN = Deno.env.get("SENTRY_DSN");

let provider: BasicTracerProvider | undefined;
if (SENTRY_DSN != null) {
  init({
    dsn: SENTRY_DSN,
    tracesSampleRate: 1.0,
    integrations: [
      ...getDefaultIntegrations({}),
      denoCronIntegration(),
    ],
    debug: true,
  });
  const client = getClient() as ConstructorParameters<typeof SentrySampler>[0];
  if (client == null) throw new Error("Sentry client not initialized.");
  getGlobalScope().setClient(client);
  setCurrentClient(client);

  setupEventContextTrace(client);
  provider = new BasicTracerProvider({
    sampler: new SentrySampler(client),
    resource: new Resource({
      [ATTR_SERVICE_NAME]: "deno",
      [SEMRESATTRS_SERVICE_NAMESPACE]: "sentry",
      [ATTR_SERVICE_VERSION]: SDK_VERSION,
    }),
    forceFlushTimeoutMillis: 500,
    spanProcessors: [new SentrySpanProcessor()],
  });
  const SentryContextManager = wrapContextManagerClass(
    AsyncLocalStorageContextManager,
  );
  provider.register({
    propagator: new SentryPropagator(),
    contextManager: new SentryContextManager(),
  });
  trace.setGlobalTracerProvider(provider);
  setOpenTelemetryContextAsyncContextStrategy();
  logger.debug("Sentry initialized.", { dsn: SENTRY_DSN });
} else {
  logger.debug(
    "Sentry not initialized: missing SENTRY_DSN environment variable.",
  );
}

export const tracerProvider = provider;
