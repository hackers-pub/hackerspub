import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccount,
  createSignupToken,
  deleteSignupToken,
  getSignupToken,
} from "./signup.ts";
import {
  createTestKv,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";

test("signup tokens round-trip through Keyv", async () => {
  const { kv } = createTestKv();

  const token = await createSignupToken(kv, "candidate@example.com", {
    inviterId: "019d9162-ffff-7fff-8fff-ffffffffffff",
  });
  const stored = await getSignupToken(kv, token.token);

  assert.ok(stored != null);
  assert.deepEqual(stored.email, "candidate@example.com");
  assert.deepEqual(stored.token, token.token);
  assert.deepEqual(stored.code, token.code);
  assert.deepEqual(stored.inviterId, "019d9162-ffff-7fff-8fff-ffffffffffff");
  assert.ok(stored.created instanceof Date);

  await deleteSignupToken(kv, token.token);

  const deleted = await getSignupToken(kv, token.token);
  assert.deepEqual(deleted, undefined);
});

test("createAccount() stores inviter and verified email", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const inviter = await insertAccountWithActor(tx, {
      username: "signupmodelinviter",
      name: "Signup Model Inviter",
      email: "signupmodelinviter@example.com",
    });
    const token = await createSignupToken(kv, "modelsignup@example.com", {
      inviterId: inviter.account.id,
    });

    const account = await createAccount(tx, token, {
      username: "modelsignup",
      name: "Model Signup",
      bio: "Created from signup model test",
      leftInvitations: 0,
    });

    assert.ok(account != null);
    assert.deepEqual(account.username, "modelsignup");
    assert.deepEqual(account.name, "Model Signup");
    assert.deepEqual(account.bio, "Created from signup model test");
    assert.deepEqual(account.inviterId, inviter.account.id);
    assert.deepEqual(account.emails.length, 1);
    assert.deepEqual(account.emails[0].email, "modelsignup@example.com");
    assert.deepEqual(account.emails[0].accountId, account.id);
    assert.deepEqual(account.emails[0].public, false);
    assert.ok(account.emails[0].verified != null);

    const storedAccount = await tx.query.accountTable.findFirst({
      where: { id: account.id },
      with: { emails: true },
    });
    assert.ok(storedAccount != null);
    assert.deepEqual(storedAccount.inviterId, inviter.account.id);
    assert.deepEqual(storedAccount.emails.map((email) => email.email), [
      "modelsignup@example.com",
    ]);
  });
});
