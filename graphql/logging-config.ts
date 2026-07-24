import { getFileSink } from "@logtape/file";
import {
  ansiColorFormatter,
  configure,
  getStreamSink,
  jsonLinesFormatter,
  type Sink,
  withFilter,
} from "@logtape/logtape";
import {
  createHmacPseudonymizer,
  redactByField,
  redactByFieldAsync,
} from "@logtape/redaction";
import { getSentrySink, type SentryNamespace } from "@logtape/sentry";
import type { Environment } from "@hackerspub/runtime/config";
import { AsyncLocalStorage } from "node:async_hooks";
import { isRoutineFederationError } from "./logFilter.ts";

export interface LoggingOptions {
  readonly environment: Environment;
  readonly stderr: WritableStream<Uint8Array>;
  readonly sentry: SentryNamespace;
}

export function redactDeviceToken(value: unknown): unknown {
  if (typeof value !== "string") return "[REDACTED]";
  const visibleChars = 8;
  if (value.length <= visibleChars) return "[REDACTED]";
  return `${"*".repeat(value.length - visibleChars)}${value.slice(
    -visibleChars,
  )}`;
}

// Field patterns whose values must never reach Sentry in the clear: the
// sign-in/sign-up token data, session/bearer tokens, web push keys, and device
// tokens. Redaction is recursive and also rewrites matching placeholders.
export const SENTRY_REDACT_FIELDS: RegExp[] = [
  /token/i,
  /code/i,
  /secret/i,
  /key/i,
  /password/i,
  /authorization/i,
  /p256dh/i,
  /auth/i,
];

export async function configureLogging(options: LoggingOptions): Promise<void> {
  const { environment, sentry, stderr } = options;
  const logQuery = environment.LOG_QUERY?.toLowerCase() === "true";
  const logFedify = environment.LOG_FEDIFY?.toLowerCase() === "true";
  const logFile = environment.LOG_FILE ?? null;
  // A blank key must behave like a missing key: the HMAC helper rejects empty
  // keys, and falling back to hard redaction is always safer.
  const secretKey = environment.SECRET_KEY || null;
  const sentryEnabled = environment.SENTRY_DSN != null;
  const sinks: Record<string, Sink> = {
    console: redactByField(
      getStreamSink(stderr, { formatter: ansiColorFormatter }),
      {
        fieldPatterns: [/^(?:apns[-_]?)?device[-_]?token$/i],
        action: redactDeviceToken,
      },
    ),
  };

  if (sentryEnabled) {
    const sentrySink = getSentrySink({
      sentry,
      enableBreadcrumbs: true,
    });
    const filteredSentrySink = withFilter(
      sentrySink,
      (record) => !isRoutineFederationError(record),
    );
    if (secretKey == null) {
      sinks.sentry = redactByField(filteredSentrySink, {
        fieldPatterns: SENTRY_REDACT_FIELDS,
        action: () => "[REDACTED]",
      });
    } else {
      const pseudonymize = await createHmacPseudonymizer({ key: secretKey });
      sinks.sentry = redactByFieldAsync(filteredSentrySink, {
        fieldPatterns: SENTRY_REDACT_FIELDS,
        action: pseudonymize,
      });
    }
  }
  if (logFile != null) {
    sinks.file = redactByField(
      getFileSink(logFile, { formatter: jsonLinesFormatter }),
      {
        fieldPatterns: [/^(?:apns[-_]?)?device[-_]?token$/i],
        action: redactDeviceToken,
      },
    );
  }
  const loggerSinks = [
    "console",
    ...(sentryEnabled ? ["sentry"] : []),
    ...(logFile != null ? ["file"] : []),
  ];

  await configure({
    contextLocalStorage: new AsyncLocalStorage(),
    sinks,
    loggers: [
      {
        category: "hackerspub",
        lowestLevel: "debug",
        sinks: loggerSinks,
      },
      {
        category: "drizzle-orm",
        lowestLevel: logQuery ? "trace" : "info",
        sinks: loggerSinks,
      },
      {
        category: "fedify",
        lowestLevel: logFedify ? "trace" : "info",
        sinks: loggerSinks,
      },
      {
        category: "vertana",
        lowestLevel: "info",
        sinks: loggerSinks,
      },
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        // The Sentry sink itself logs here. Routing this category back into
        // Sentry would recurse, while the file sink remains safe.
        sinks: ["console", ...(logFile != null ? ["file"] : [])],
      },
    ],
  });
}
