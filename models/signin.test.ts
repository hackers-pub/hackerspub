import assert from "node:assert/strict";
import test from "node:test";
import {
  createSigninToken,
  deleteSigninToken,
  getSigninToken,
} from "./signin.ts";
import { createTestKv } from "../test/postgres.ts";

test("signin tokens round-trip through Keyv", async () => {
  const { kv } = createTestKv();
  const accountId = "019d9162-ffff-7fff-8fff-ffffffffffff";

  const token = await createSigninToken(kv, accountId);
  const stored = await getSigninToken(kv, token.token);

  assert.ok(stored != null);
  assert.deepEqual(stored.accountId, accountId);
  assert.deepEqual(stored.token, token.token);
  assert.deepEqual(stored.code, token.code);
  assert.ok(stored.created instanceof Date);
  assert.deepEqual(/^[0-9A-Z]{6}$/.test(stored.code), true);

  await deleteSigninToken(kv, token.token);

  const deleted = await getSigninToken(kv, token.token);
  assert.deepEqual(deleted, undefined);
});
