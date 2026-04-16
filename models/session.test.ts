import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { createSession, deleteSession, getSession } from "./session.ts";
import { createTestKv } from "../test/postgres.ts";

Deno.test({
  name: "sessions round-trip through Keyv",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { kv } = createTestKv();
    const createdAt = new Date("2026-04-15T00:00:00.000Z");

    const session = await createSession(kv, {
      id: "019d9162-ffff-7fff-8fff-ffffffffffff",
      accountId: "019d9162-eeee-7eee-8eee-eeeeeeeeeeee",
      userAgent: "session-test",
      ipAddress: "127.0.0.1",
      created: createdAt,
    });

    assertEquals(session.id, "019d9162-ffff-7fff-8fff-ffffffffffff");
    assertEquals(session.accountId, "019d9162-eeee-7eee-8eee-eeeeeeeeeeee");
    assertEquals(session.userAgent, "session-test");
    assertEquals(session.ipAddress, "127.0.0.1");
    assertEquals(session.created, createdAt);

    const stored = await getSession(kv, session.id);
    assert(stored != null);
    assertEquals(stored, session);

    assertEquals(await deleteSession(kv, session.id), true);
    assertEquals(await getSession(kv, session.id), undefined);
  },
});
