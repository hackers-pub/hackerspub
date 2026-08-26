import assert from "node:assert/strict";
import test from "node:test";
import type { LogRecord } from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";
import { isRoutineFederationError } from "./logFilter.ts";
import { redactDeviceToken, SENTRY_REDACT_FIELDS } from "./logging-config.ts";

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
