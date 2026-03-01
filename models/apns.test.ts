import { assertEquals } from "@std/assert/equals";
import { normalizeApnsDeviceToken } from "./apns.ts";

const VALID_TOKEN = "0123456789abcdef".repeat(4);

Deno.test("normalizeApnsDeviceToken()", async (t) => {
  await t.step("accepts valid lowercase token", () => {
    assertEquals(normalizeApnsDeviceToken(VALID_TOKEN), VALID_TOKEN);
  });

  await t.step("normalizes uppercase token with wrappers", () => {
    const wrappedUppercaseToken = `  <${VALID_TOKEN.toUpperCase()}>\n`;
    assertEquals(normalizeApnsDeviceToken(wrappedUppercaseToken), VALID_TOKEN);
  });

  await t.step("rejects tokens shorter than 64 hex characters", () => {
    assertEquals(normalizeApnsDeviceToken(VALID_TOKEN.slice(0, -1)), null);
  });

  await t.step("rejects tokens containing non-hex characters", () => {
    const invalidToken = `${VALID_TOKEN.slice(0, -1)}g`;
    assertEquals(normalizeApnsDeviceToken(invalidToken), null);
  });
});
