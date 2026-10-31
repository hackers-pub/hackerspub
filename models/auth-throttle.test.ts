import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import test from "node:test";
import { db } from "../test/database.ts";
import { consumeAuthThrottle } from "./auth-throttle.ts";
import { authThrottleTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";

test("consumeAuthThrottle enforces a fixed window and resets it", async () => {
  const key = `test:${generateUuidV7()}`;
  const now = new Date("2026-10-31T00:00:00Z");
  try {
    assertEquals(
      (await consumeAuthThrottle(db, key, 2, 60_000, now)).allowed,
      true,
    );
    assertEquals(
      (await consumeAuthThrottle(db, key, 2, 60_000, now)).allowed,
      true,
    );
    const denied = await consumeAuthThrottle(db, key, 2, 60_000, now);
    assertEquals(denied.allowed, false);
    assertEquals(denied.retryAfterSeconds, 60);

    const fractional = await consumeAuthThrottle(
      db,
      key,
      2,
      60_000,
      new Date(now.getTime() + 59_700),
    );
    assertEquals(fractional.allowed, false);
    assertEquals(fractional.retryAfterSeconds, 1);

    const reset = await consumeAuthThrottle(
      db,
      key,
      2,
      60_000,
      new Date(now.getTime() + 60_001),
    );
    assertEquals(reset.allowed, true);
  } finally {
    await db.delete(authThrottleTable).where(eq(authThrottleTable.key, key));
  }
});
