import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execute, parse } from "graphql";
import { eq } from "drizzle-orm";
import type { Message } from "@upyo/core";
import {
  createEmailSigninToken,
  createSigninToken,
} from "@hackerspub/models/signin";
import {
  accountEmailChallengeTable,
  accountEmailTable,
  accountTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import type { UserContext } from "./builder.ts";
import { getAccountEmailMessage } from "./account-email-message.ts";
import { schema } from "./mod.ts";
import { db } from "../test/database.ts";
import type { Transaction } from "@hackerspub/models/db";
import { removeEmail } from "@hackerspub/models/account-email";
import {
  createTestEmailTransport,
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
  withExclusiveTestDatabase,
} from "../test/postgres.ts";

async function run(
  ctx: UserContext,
  source: string,
  variables: Record<string, unknown> = {},
) {
  const result = await execute({
    schema,
    document: parse(source),
    variableValues: variables,
    contextValue: ctx,
    onError: "NO_PROPAGATE",
  });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return toPlainJson(result.data) as Record<
    string,
    Record<string, unknown> | null
  >;
}
const privateQuery =
  "query($username:String!){accountByUsername(username:$username){emails{email primary verified} emailManagementAvailableUntil}}";
const requestMutation =
  'mutation($email:Email!){requestAccountEmailVerification(input:{email:$email,locale:"en-US"}){__typename ... on RequestAccountEmailVerificationPayload{token expires} ... on AccountEmailError{code retryAfter}}}';
const verifyMutation =
  "mutation($token:UUID!,$code:String!){verifyAccountEmail(input:{token:$token,code:$code}){__typename ... on VerifyAccountEmailPayload{account{emails{email primary}}} ... on AccountEmailError{code}}}";

const freshSession = (
  id: `${string}-${string}-${string}-${string}-${string}`,
) => ({ id: generateUuidV7(), accountId: id, created: new Date() });

test("email fields are private and all sensitive actions require recent authentication", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "emailprivate",
      name: "Private",
      email: "emailprivate@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "emailviewer",
      name: "Viewer",
      email: "emailviewer@example.com",
    });
    for (const ctx of [
      makeGuestContext(tx),
      makeUserContext(tx, other.account),
      makeUserContext(tx, { ...other.account, moderator: true }),
    ]) {
      const data = await run(ctx, privateQuery, { username: account.username });
      assert.equal(data.accountByUsername?.emails, null);
      assert.equal(data.accountByUsername?.emailManagementAvailableUntil, null);
    }
    const owner = makeUserContext(tx, account, {
      session: freshSession(account.id),
    });
    const owned = await run(owner, privateQuery, {
      username: account.username,
    });
    assert.equal((owned.accountByUsername!.emails as unknown[]).length, 1);
    assert.ok(owned.accountByUsername?.emailManagementAvailableUntil);
    const stale = makeUserContext(tx, account);
    const requested = await run(stale, requestMutation, {
      email: "addition@example.com",
    });
    assert.equal(
      requested.requestAccountEmailVerification?.code,
      "REAUTHENTICATION_REQUIRED",
    );
    for (const operation of ["setPrimaryAccountEmail", "removeAccountEmail"]) {
      const result = await run(
        stale,
        `mutation{${operation}(input:{email:"emailprivate@example.com"}){... on AccountEmailError{code}}}`,
      );
      assert.equal(result[operation]?.code, "REAUTHENTICATION_REQUIRED");
    }
  });
});

test("API verification returns a fresh list, persists wrong attempts, accepts approved requests after freshness expires, and sends notices", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "emailapiverify",
      name: "Verify",
      email: "emailapiverify@example.com",
    });
    const email = createTestEmailTransport();
    const ctx = makeUserContext(tx, account, {
      email: email.transport,
      session: freshSession(account.id),
    });
    const requested = await run(ctx, requestMutation, {
      email: "emailapiother@example.com",
    });
    const token = requested.requestAccountEmailVerification?.token;
    assert.equal(email.messages.length, 1);
    const sent = email.messages[0] as Message;
    const code = sent.content.text?.match(/\n\n([A-Z2-9]{8})\n\n/)?.[1];
    assert.ok(code);
    assert.deepEqual(
      sent.recipients.map((recipient) => recipient.address),
      ["emailapiother@example.com"],
    );
    const wrong = await run(ctx, verifyMutation, { token, code: "AAAAAAAA" });
    assert.equal(wrong.verifyAccountEmail?.code, "INVALID_CODE");
    const rows = await tx.select().from(accountEmailChallengeTable);
    assert.equal(rows[0].attempts, 1);
    const anotherSession = { ...ctx, session: freshSession(account.id) };
    assert.equal(
      (await run(anotherSession, verifyMutation, { token, code }))
        .verifyAccountEmail?.code,
      "INVALID_CODE",
    );
    const staleNow = {
      ...ctx,
      session: { ...ctx.session!, created: new Date(Date.now() - 11 * 60000) },
    };
    const verified = await run(staleNow, verifyMutation, { token, code });
    assert.equal(
      verified.verifyAccountEmail?.__typename,
      "VerifyAccountEmailPayload",
    );
    assert.equal(
      (verified.verifyAccountEmail!.account as { emails: unknown[] }).emails
        .length,
      2,
    );
    assert.equal(email.messages.length, 2);
    assert.deepEqual(
      (email.messages[1] as Message).recipients.map(
        (recipient) => recipient.address,
      ),
      ["emailapiverify@example.com"],
    );
    const change = await run(
      ctx,
      'mutation{setPrimaryAccountEmail(input:{email:"emailapiother@example.com"}){... on SetPrimaryAccountEmailPayload{account{emails{email primary}}}}}',
    );
    const updated = (
      change.setPrimaryAccountEmail!.account as {
        emails: { email: string; primary: boolean }[];
      }
    ).emails;
    assert.equal(
      updated.find((item) => item.primary)?.email,
      "emailapiother@example.com",
    );
    const syncedActor = await tx.query.actorTable.findFirst({
      where: { accountId: account.id },
    });
    const primaryHash = createHash("sha256")
      .update("emailapiother@example.com")
      .digest("hex");
    assert.ok(syncedActor?.avatarUrl?.includes(primaryHash));
    const removal = await run(
      ctx,
      'mutation{removeAccountEmail(input:{email:"emailapiverify@example.com"}){... on RemoveAccountEmailPayload{account{emails{email}}}}}',
    );
    assert.equal(
      (removal.removeAccountEmail!.account as { emails: unknown[] }).emails
        .length,
      1,
    );
    assert.ok(
      (email.messages.at(-2) as Message).recipients.some(
        (recipient) => recipient.address === "emailapiverify@example.com",
      ),
    );
  });
});

test("delivery failure invalidates a challenge but retains throttle, while notice failure preserves the change", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "emailapidelivery",
      name: "Delivery",
      email: "emailapidelivery@example.com",
    });
    const failure = {
      send: async () => ({ successful: false }),
    } as unknown as UserContext["email"];
    const ctx = makeUserContext(tx, account, {
      email: failure,
      session: freshSession(account.id),
    });
    const requested = await run(ctx, requestMutation, {
      email: "deliveryother@example.com",
    });
    assert.equal(
      requested.requestAccountEmailVerification?.code,
      "DELIVERY_FAILED",
    );
    const [row] = await tx.select().from(accountEmailChallengeTable);
    assert.equal(row.used, true);
    assert.equal(
      (await run(ctx, requestMutation, { email: "deliveryother@example.com" }))
        .requestAccountEmailVerification?.code,
      "RATE_LIMITED",
    );
    await tx.insert(accountEmailTable).values({
      accountId: account.id,
      email: "deliveryverified@example.com",
      verified: new Date(),
    });
    const changed = await run(
      ctx,
      'mutation{setPrimaryAccountEmail(input:{email:"deliveryverified@example.com"}){__typename}}',
    );
    assert.equal(
      changed.setPrimaryAccountEmail?.__typename,
      "SetPrimaryAccountEmailPayload",
    );
  });
});

test("login uses only verified addresses, targets the requested mailbox, and rejects links for removed addresses", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "emaillogin",
      name: "Login",
      email: "emaillogin@example.com",
    });
    await tx.insert(accountEmailTable).values([
      {
        accountId: account.id,
        email: "emailloginother@example.com",
        verified: new Date(),
      },
      { accountId: account.id, email: "emailloginpending@example.com" },
    ]);
    const email = createTestEmailTransport();
    const { kv } = createTestKv();
    const guest = makeGuestContext(tx, { email: email.transport, kv });
    const login =
      'mutation($email:String!){loginByEmail(email:$email,locale:"en-US",verifyUrl:"http://localhost/sign/in/{token}?code={code}"){__typename ... on LoginChallenge{token}}}';
    assert.equal(
      (await run(guest, login, { email: "emailloginpending@example.com" }))
        .loginByEmail?.__typename,
      "AccountNotFoundError",
    );
    await run(guest, login, { email: "EMAILLOGINOTHER@example.com" });
    assert.equal(email.messages.length, 1);
    assert.deepEqual(
      (email.messages[0] as Message).recipients.map(
        (recipient) => recipient.address,
      ),
      ["emailloginother@example.com"],
    );
    const token = await createSigninToken(kv, account.id, [
      "emailloginother@example.com",
    ]);
    const reserved = await createEmailSigninToken(tx, kv, account.id);
    assert.ok(reserved);
    const legacy = await createSigninToken(kv, account.id);
    const owner = makeUserContext(tx, account, {
      kv,
      session: freshSession(account.id),
    });
    await run(
      owner,
      'mutation{removeAccountEmail(input:{email:"emailloginother@example.com"}){__typename}}',
    );
    for (const challenge of [token, legacy]) {
      const complete = await run(
        guest,
        "mutation($token:UUID!,$code:String!){completeLoginChallenge(token:$token,code:$code){__typename}}",
        { token: challenge.token, code: challenge.code },
      );
      assert.equal(complete.completeLoginChallenge, null);
    }
    await tx.insert(accountEmailTable).values({
      accountId: account.id,
      email: "emailloginother@example.com",
      verified: new Date(),
    });
    const revived = await run(
      guest,
      "mutation($token:UUID!,$code:String!){completeLoginChallenge(token:$token,code:$code){__typename}}",
      { token: reserved.token, code: reserved.code },
    );
    assert.equal(revived.completeLoginChallenge, null);
    await tx
      .update(accountTable)
      .set({ kind: "organization" })
      .where(eq(accountTable.id, account.id));
    assert.equal(
      (await run(owner, privateQuery, { username: account.username }))
        .accountByUsername?.emails,
      null,
    );
  });
});

test("username login issuance re-reads recipients after concurrent removal under the account lock", async () => {
  await withExclusiveTestDatabase(async () => {
    const { account } = await insertAccountWithActor(db as Transaction, {
      username: "emailissuancerace",
      name: "Race",
      email: "issuancea@example.com",
    });
    const { kv } = createTestKv();
    let issuance: ReturnType<typeof createEmailSigninToken> | undefined;
    try {
      await db.insert(accountEmailTable).values({
        accountId: account.id,
        email: "issuanceb@example.com",
        verified: new Date(),
      });
      await db.transaction(async (tx) => {
        await tx
          .select({ id: accountTable.id })
          .from(accountTable)
          .where(eq(accountTable.id, account.id))
          .for("update");
        // Issuance must wait, then take a fresh snapshot after removal commits.
        issuance = createEmailSigninToken(db, kv, account.id);
        await removeEmail(tx, account.id, "issuanceb@example.com");
      });
      const token = await issuance;
      assert.ok(token);
      assert.deepEqual(token.emails, ["issuancea@example.com"]);
      const guest = makeGuestContext(db as Transaction, { kv });
      const completed = await run(
        guest,
        "mutation($token:UUID!,$code:String!){completeLoginChallenge(token:$token,code:$code){__typename}}",
        { token: token.token, code: token.code },
      );
      assert.equal(completed.completeLoginChallenge?.__typename, "Session");
    } finally {
      await issuance;
      await db.delete(accountTable).where(eq(accountTable.id, account.id));
    }
  });
});

test("username login distinguishes an existing account without verified emails from an unknown account", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "emailunavailable",
      name: "Unavailable",
      email: "unavailable@example.com",
    });
    await tx
      .delete(accountEmailTable)
      .where(eq(accountEmailTable.accountId, account.id));
    const { kv, store } = createTestKv();
    const email = createTestEmailTransport();
    const guest = makeGuestContext(tx, { kv, email: email.transport });
    const login =
      'mutation($username:String!){loginByUsername(username:$username,locale:"en-US",verifyUrl:"http://localhost/sign/in/{token}?code={code}"){__typename}}';
    assert.equal(
      (await run(guest, login, { username: "emaildoesnotexist" }))
        .loginByUsername?.__typename,
      "AccountNotFoundError",
    );
    assert.equal(
      (await run(guest, login, { username: account.username })).loginByUsername
        ?.__typename,
      "EmailLoginUnavailableError",
    );
    await tx
      .insert(accountEmailTable)
      .values({ accountId: account.id, email: "unavailable@example.com" });
    assert.equal(
      (await run(guest, login, { username: account.username })).loginByUsername
        ?.__typename,
      "EmailLoginUnavailableError",
    );
    // No code is issued or mail sent to an unverified address.
    assert.equal(store.size, 0);
    assert.equal(email.messages.length, 0);
    const byEmail = await run(
      guest,
      'mutation{loginByEmail(email:"unavailable@example.com",locale:"en-US",verifyUrl:"http://localhost/sign/in/{token}?code={code}"){__typename}}',
    );
    assert.equal(byEmail.loginByEmail?.__typename, "AccountNotFoundError");
    await tx
      .update(accountEmailTable)
      .set({ verified: new Date(), primary: true })
      .where(eq(accountEmailTable.accountId, account.id));
    assert.equal(
      (await run(guest, login, { username: account.username })).loginByUsername
        ?.__typename,
      "LoginChallenge",
    );
    assert.equal(email.messages.length, 1);
  });
});

test("verification and change templates exist in every locale and HTML escapes untrusted text", async () => {
  for (const locale of ["en-US", "ja-JP", "ko-KR", "zh-CN", "zh-TW", "fr-FR"]) {
    for (const kind of ["verification", "change"] as const) {
      const message = await getAccountEmailMessage({
        from: "noreply@example.com",
        to: "user@example.com",
        locale: new Intl.Locale(locale),
        username: '<script>alert("x")</script>',
        kind,
        code: "23456789",
      });
      assert.ok(message.subject.length > 0);
      assert.ok(message.content.text);
      assert.doesNotMatch(
        "html" in message.content ? (message.content.html ?? "") : "",
        /<script>/,
      );
      if (kind === "verification")
        assert.match(message.content.text!, /23456789/);
    }
  }
});
