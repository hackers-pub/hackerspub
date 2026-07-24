import assert from "node:assert/strict";
import test from "node:test";
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
