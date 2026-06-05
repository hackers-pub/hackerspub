import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeApnsDeviceToken } from "./apns.ts";

const VALID_TOKEN = "0123456789abcdef".repeat(4);

describe("normalizeApnsDeviceToken()", () => {
  it("accepts valid lowercase token", () => {
    assert.deepEqual(normalizeApnsDeviceToken(VALID_TOKEN), VALID_TOKEN);
  });

  it("normalizes uppercase token with wrappers", () => {
    const wrappedUppercaseToken = `  <${VALID_TOKEN.toUpperCase()}>\n`;
    assert.deepEqual(
      normalizeApnsDeviceToken(wrappedUppercaseToken),
      VALID_TOKEN,
    );
  });

  it("rejects tokens shorter than 64 hex characters", () => {
    assert.deepEqual(normalizeApnsDeviceToken(VALID_TOKEN.slice(0, -1)), null);
  });

  it("rejects tokens containing non-hex characters", () => {
    const invalidToken = `${VALID_TOKEN.slice(0, -1)}g`;
    assert.deepEqual(normalizeApnsDeviceToken(invalidToken), null);
  });
});
