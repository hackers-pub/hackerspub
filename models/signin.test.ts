import { configure, type LogRecord, reset } from "@logtape/logtape";
import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import {
  createSigninToken,
  deleteSigninToken,
  getSigninToken,
} from "./signin.ts";
import { createTestKv } from "../test/postgres.ts";

Deno.test({
  name: "signin tokens round-trip through Keyv",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { kv } = createTestKv();
    const accountId = "019d9162-ffff-7fff-8fff-ffffffffffff";

    const token = await createSigninToken(kv, accountId);
    const stored = await getSigninToken(kv, token.token);

    assert(stored != null);
    assertEquals(stored.accountId, accountId);
    assertEquals(stored.token, token.token);
    assertEquals(stored.code, token.code);
    assert(stored.created instanceof Date);
    assertEquals(/^[0-9A-Z]{6}$/.test(stored.code), true);

    await deleteSigninToken(kv, token.token);

    const deleted = await getSigninToken(kv, token.token);
    assertEquals(deleted, undefined);
  },
});

Deno.test({
  name: "signin token debug log omits replay secrets",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { kv } = createTestKv();
    const records: LogRecord[] = [];
    const accountId = "019d9162-ffff-7fff-8fff-ffffffffffff";

    await configure({
      reset: true,
      sinks: { capture: (record) => records.push(record) },
      loggers: [
        {
          category: ["hackerspub", "models", "signin"],
          lowestLevel: "debug",
          sinks: ["capture"],
        },
      ],
    });

    try {
      const token = await createSigninToken(kv, accountId);
      const record = records.find((record) =>
        record.rawMessage ===
          "Created sign-in token for {accountId} (expires in {expires})"
      );

      assert(record != null);
      assertEquals(record.properties.accountId, accountId);
      assertEquals(record.properties.token, undefined);
      assertEquals(record.properties.code, undefined);

      const serializedProperties = JSON.stringify(record.properties);
      assertEquals(serializedProperties.includes(token.token), false);
      assertEquals(serializedProperties.includes(token.code), false);
    } finally {
      await reset();
    }
  },
});
