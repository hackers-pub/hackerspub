import assert from "node:assert/strict";
import test from "node:test";
import { getLogger, type LogRecord, reset } from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";
import { isRoutineFederationError } from "./logFilter.ts";
import {
  configureLogging,
  redactDeviceToken,
  SENTRY_REDACT_FIELDS,
} from "./logging-config.ts";

test("device token redaction preserves only the correlation suffix", () => {
  assert.equal(redactDeviceToken("short"), "[REDACTED]");
  assert.equal(redactDeviceToken("0123456789abcdef"), "********89abcdef");
  assert.equal(redactDeviceToken({ token: "value" }), "[REDACTED]");
});

test("Sentry redaction covers authentication and device secrets", () => {
  for (const field of [
    "token",
    "otpCode",
    "secretKey",
    "password",
    "authorization",
    "p256dh",
    "auth",
    "apnsDeviceToken",
  ]) {
    assert(
      SENTRY_REDACT_FIELDS.some((pattern) => pattern.test(field)),
      `${field} must be redacted`,
    );
  }
  assert.equal(
    SENTRY_REDACT_FIELDS.some((pattern) => pattern.test("username")),
    false,
  );
});

test("Sentry redaction preserves transactional outbox classification", async () => {
  const original: LogRecord = {
    category: ["hackerspub", "federation", "transactional-outbox"],
    level: "error",
    message: ["Outbox event {eventId} failed permanently."],
    rawMessage: "Outbox event {eventId} failed permanently.",
    timestamp: 0,
    properties: {
      eventId: "019c1234",
      eventType: "activitypub.delivery",
      error: {
        name: "SendActivityError",
        message: "Remote delivery failed.",
        details: { statusCode: 410 },
      },
    },
  };
  let redacted: LogRecord | undefined;
  const sink = redactByField(
    (record) => {
      redacted = record;
    },
    {
      fieldPatterns: SENTRY_REDACT_FIELDS,
      action: () => "[REDACTED]",
    },
  );

  await sink(original);

  assert.ok(redacted);
  assert.equal(isRoutineFederationError(redacted), true);
  assert.equal(
    (redacted.properties.error as { details: { statusCode: string } }).details
      .statusCode,
    "[REDACTED]",
  );
});

test("development email contents reach the console without becoming Sentry events or breadcrumbs", async () => {
  const consoleChunks: string[] = [];
  const sentryEvents: unknown[] = [];
  const breadcrumbs: unknown[] = [];
  await configureLogging({
    environment: { SENTRY_DSN: "enabled" },
    stderr: new WritableStream({
      write(chunk) {
        consoleChunks.push(new TextDecoder().decode(chunk));
      },
    }),
    sentry: {
      captureMessage(message) {
        sentryEvents.push(message);
        return "event";
      },
      captureException(exception) {
        sentryEvents.push(exception);
        return "event";
      },
      getActiveSpan() {
        return undefined;
      },
      getClient() {
        return { getOptions: () => ({ enableLogs: true }) };
      },
      getIsolationScope() {
        return {
          addBreadcrumb: (breadcrumb) => {
            breadcrumbs.push(breadcrumb);
          },
        };
      },
      logger: {
        info(message) {
          sentryEvents.push(message);
        },
      },
    },
  });
  try {
    getLogger(["hackerspub", "email", "development"]).info(
      "Development email: {body}",
      { body: "verification-code-ABC123" },
    );
    getLogger(["hackerspub", "runtime"]).info("Ordinary runtime log");
  } finally {
    await reset();
  }
  assert.match(consoleChunks.join(""), /verification-code-ABC123/);
  assert.match(JSON.stringify(sentryEvents), /Ordinary runtime log/);
  assert.doesNotMatch(JSON.stringify(sentryEvents), /verification-code-ABC123/);
  assert.doesNotMatch(JSON.stringify(breadcrumbs), /verification-code-ABC123/);
});
