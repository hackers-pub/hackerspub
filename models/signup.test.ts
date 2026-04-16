import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
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

Deno.test({
  name: "signup tokens round-trip through Keyv",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { kv } = createTestKv();

    const token = await createSignupToken(kv, "candidate@example.com", {
      inviterId: "019d9162-ffff-7fff-8fff-ffffffffffff",
    });
    const stored = await getSignupToken(kv, token.token);

    assert(stored != null);
    assertEquals(stored.email, "candidate@example.com");
    assertEquals(stored.token, token.token);
    assertEquals(stored.code, token.code);
    assertEquals(stored.inviterId, "019d9162-ffff-7fff-8fff-ffffffffffff");
    assert(stored.created instanceof Date);

    await deleteSignupToken(kv, token.token);

    const deleted = await getSignupToken(kv, token.token);
    assertEquals(deleted, undefined);
  },
});

Deno.test({
  name: "createAccount() stores inviter and verified email",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assert(account != null);
      assertEquals(account.username, "modelsignup");
      assertEquals(account.name, "Model Signup");
      assertEquals(account.bio, "Created from signup model test");
      assertEquals(account.inviterId, inviter.account.id);
      assertEquals(account.emails.length, 1);
      assertEquals(account.emails[0].email, "modelsignup@example.com");
      assertEquals(account.emails[0].accountId, account.id);
      assertEquals(account.emails[0].public, false);
      assert(account.emails[0].verified != null);

      const storedAccount = await tx.query.accountTable.findFirst({
        where: { id: account.id },
        with: { emails: true },
      });
      assert(storedAccount != null);
      assertEquals(storedAccount.inviterId, inviter.account.id);
      assertEquals(storedAccount.emails.map((email) => email.email), [
        "modelsignup@example.com",
      ]);
    });
  },
});
