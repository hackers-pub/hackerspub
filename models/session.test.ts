import assert from "node:assert";
import test from "node:test";
import { createSession, deleteSession, getSession } from "./session.ts";
import { createTestKv } from "../test/postgres.ts";

test("sessions round-trip through Keyv", async () => {
  const { kv } = createTestKv();
  const createdTime = new Date("2026-04-15T00:00:00.000Z");

  const session = await createSession(kv, {
    id: "019d9162-ffff-7fff-8fff-ffffffffffff",
    accountId: "019d9162-eeee-7eee-8eee-eeeeeeeeeeee",
    userAgent: "session-test",
    ipAddress: "127.0.0.1",
    created: createdTime,
  });

  assert.deepEqual(session.id, "019d9162-ffff-7fff-8fff-ffffffffffff");
  assert.deepEqual(session.accountId, "019d9162-eeee-7eee-8eee-eeeeeeeeeeee");
  assert.deepEqual(session.userAgent, "session-test");
  assert.deepEqual(session.ipAddress, "127.0.0.1");
  assert.deepEqual(session.created, createdTime);

  const stored = await getSession(kv, session.id);
  assert.ok(stored != null);
  assert.deepEqual(stored, session);

  assert.deepEqual(await deleteSession(kv, session.id), true);
  assert.deepEqual(await getSession(kv, session.id), undefined);
});
