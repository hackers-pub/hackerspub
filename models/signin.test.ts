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
