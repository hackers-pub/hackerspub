import assert from "node:assert/strict";
import test from "node:test";
import Keyv from "keyv";
import { createSession, getSession, getSessionFreshUntil } from "./session.ts";

test("recent authentication works after Keyv serialization and tolerates bounded clock skew and rejects invalid, far-future and stale dates", async () => {
  const kv = new Keyv();
  const now = new Date();
  const session = await createSession(kv, {
    accountId: crypto.randomUUID(),
    created: now,
  });
  const restored = await getSession(kv, session.id);
  assert.ok(restored);
  assert.equal(typeof restored.created, "string");
  assert.equal(
    getSessionFreshUntil(restored, now)?.getTime(),
    now.getTime() + 600000,
  );
  assert.equal(
    getSessionFreshUntil(restored, new Date(now.getTime() + 600000)),
    undefined,
  );
  assert.equal(
    getSessionFreshUntil({ ...session, created: new Date("invalid") }, now),
    undefined,
  );
  assert.equal(
    getSessionFreshUntil(
      { ...session, created: new Date(now.getTime() + 60000) },
      now,
    )?.getTime(),
    now.getTime() + 660000,
  );
  assert.equal(
    getSessionFreshUntil(
      { ...session, created: new Date(now.getTime() + 60001) },
      now,
    ),
    undefined,
  );
});
