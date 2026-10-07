import assert from "node:assert/strict";
import test from "node:test";
import { execute, parse } from "graphql";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import {
  changeAccountSecurity,
  consumeRecoveryCode,
  consumeRecoveryRegistrationGrant,
  createRecoveryRegistrationGrant,
  getSecurityAuthenticationOptions,
  type SecurityAction,
} from "@hackerspub/models/account-security";
import type { Database, Transaction } from "@hackerspub/models/db";
import {
  accountRecoveryCodeTable,
  accountTable,
  actorTable,
  passkeyTable,
} from "@hackerspub/models/schema";
import {
  createSession,
  getSession,
  sessionMatchesAccount,
  type Session,
} from "@hackerspub/models/session";
import {
  createEmailSigninToken,
  createSigninToken,
  getSigninToken,
} from "@hackerspub/models/signin";
import { createWebAuthnCredential } from "../test/webauthn.ts";
import { db } from "../test/database.ts";
import {
  createTestEmailTransport,
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withExclusiveTestDatabase,
  withRollback,
} from "../test/postgres.ts";
import type { UserContext } from "./builder.ts";
import { createYogaServer, schema } from "./mod.ts";
import { getAccountSecurityMessage } from "./account-security-message.ts";

async function run(
  ctx: UserContext,
  source: string,
  variables: Record<string, unknown> = {},
) {
  return await execute({
    schema,
    document: parse(source),
    variableValues: variables,
    contextValue: ctx,
    onError: "NO_PROPAGATE",
  });
}
const sessionFor = (
  accountId: Session["accountId"],
  authenticationMethod: Session["authenticationMethod"] = "passkey",
): Session => ({
  id: crypto.randomUUID(),
  accountId,
  created: new Date("2020-01-01"),
  authenticationMethod,
});
async function proof(
  db: Database | Transaction,
  kv: UserContext["kv"],
  session: Session,
  key: ReturnType<typeof createWebAuthnCredential>,
  action: SecurityAction,
) {
  const { challengeId, options } = await getSecurityAuthenticationOptions(
    db,
    kv,
    "http://localhost",
    session,
    action,
  );
  return {
    challengeId,
    authenticationResponse: key.assertion(options.challenge),
  };
}
const enable =
  'mutation($challengeId:UUID!,$response:JSON!){enableAccountPasskeyOnly(input:{challengeId:$challengeId,authenticationResponse:$response,locale:"en-US"}){__typename ... on EnableAccountPasskeyOnlyPayload{account{id emailLoginEnabled recoveryCodeCount} session{id} recoveryCodes} ... on AccountSecurityError{code}}}';
const recovery =
  "mutation($username:String!,$code:String!){loginByRecoveryCode(username:$username,code:$code){__typename ... on RecoveryLoginPayload{session{id} registrationToken} ... on AccountBannedError{since}}}";
const complete =
  "mutation($token:UUID!,$code:String!){completeLoginChallenge(token:$token,code:$code){__typename}}";

test("strict mode hashes ten codes, blocks pending email tokens, preserves response shape, and keeps old sessions revoked after disabling", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "strictinitial",
      name: "Strict",
      email: "strict@example.com",
    });
    const { kv, store } = createTestKv();
    const email = createTestEmailTransport();
    const session = sessionFor(account.id, "email");
    const key = createWebAuthnCredential();
    await key.insert(tx, account.id);
    const old = await createEmailSigninToken(tx, kv, account.id);
    assert.ok(old);
    const legacy = await createSigninToken(kv, account.id);
    const guest = makeGuestContext(tx, { kv, email: email.transport });
    const assertion = await proof(tx, kv, session, key, "ENABLE");
    const response = await run(
      makeUserContext(tx, account, { kv, session, email: email.transport }),
      enable,
      {
        challengeId: assertion.challengeId,
        response: assertion.authenticationResponse,
      },
    );
    assert.equal(response.errors, undefined);
    const payload = toPlainJson(response.data)?.enableAccountPasskeyOnly as {
      recoveryCodes: string[];
      session: { id: Session["id"] };
      account: { emailLoginEnabled: boolean; recoveryCodeCount: number };
    };
    assert.equal(payload.account.emailLoginEnabled, false);
    assert.equal(payload.account.recoveryCodeCount, 10);
    assert.equal(payload.recoveryCodes.length, 10);
    assert.equal(new Set(payload.recoveryCodes).size, 10);
    const hashes = await tx.select().from(accountRecoveryCodeTable);
    assert.ok(
      hashes.every(
        (row) =>
          /^[0-9a-f]{64}$/.test(row.codeHash) &&
          !payload.recoveryCodes.includes(row.codeHash),
      ),
    );
    assert.equal(
      (await getSession(kv, payload.session.id))?.authenticationMethod,
      "passkey",
    );
    const strict = await tx.query.accountTable.findFirst({
      where: { id: account.id },
    });
    assert.ok(strict);
    assert.equal(sessionMatchesAccount(session, strict), false);
    assert.equal(
      sessionMatchesAccount(
        { ...session, authenticationMethod: undefined },
        strict,
      ),
      false,
    );
    assert.equal(
      sessionMatchesAccount(
        { ...session, authenticationMethod: "passkey" },
        strict,
      ),
      true,
    );
    assert.equal(
      sessionMatchesAccount(
        { ...session, authenticationMethod: "recovery" },
        strict,
      ),
      true,
    );
    for (const token of [old, legacy])
      assert.equal(
        toPlainJson(
          (await run(guest, complete, { token: token.token, code: token.code }))
            .data,
        )?.completeLoginChallenge,
        null,
      );
    for (const field of ["loginByEmail", "loginByUsername"]) {
      const args =
        field === "loginByEmail"
          ? 'email:"strict@example.com"'
          : 'username:"strictinitial"';
      const result = await run(
        guest,
        `mutation{${field}(${args},locale:"en-US",verifyUrl:"http://localhost/{token}?code={code}"){__typename ... on LoginChallenge{token}}}`,
      );
      assert.equal(result.errors, undefined);
      const challenge = toPlainJson(result.data)?.[field] as {
        __typename: string;
        token: Session["id"];
      };
      assert.equal(challenge.__typename, "LoginChallenge");
      assert.equal(await getSigninToken(kv, challenge.token), undefined);
    }
    assert.equal(email.messages.length, 3); // enabled notice and two sign-in notices
    const passkeySession = (await getSession(kv, payload.session.id))!;
    const disabled = await changeAccountSecurity(
      tx,
      kv,
      "http://localhost",
      passkeySession,
      "DISABLE",
      await proof(tx, kv, passkeySession, key, "DISABLE"),
    );
    assert.equal(disabled.account.emailLoginEnabled, true);
    assert.equal(sessionMatchesAccount(session, disabled.account), false);
    assert.equal((await tx.select().from(accountRecoveryCodeTable)).length, 0);
    const issued = await createEmailSigninToken(tx, kv, account.id);
    assert.ok(issued);
    const loggedIn = await run(guest, complete, {
      token: issued.token,
      code: issued.code,
    });
    assert.equal(loggedIn.errors, undefined);
    assert.equal(
      (
        toPlainJson(loggedIn.data)!.completeLoginChallenge as {
          __typename: string;
        }
      ).__typename,
      "Session",
    );
    assert.ok(
      !JSON.stringify([...store.values()]).includes(payload.recoveryCodes[0]),
    );
  });
});

test("purpose, session, origin, user verification, expiry, and zero-counter replay are enforced; rotation invalidates codes and grants", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "strictproof",
      name: "Proof",
      email: "proof@example.com",
    });
    const { kv, store } = createTestKv();
    const session = sessionFor(account.id);
    const key = createWebAuthnCredential();
    await key.insert(tx, account.id);
    const enabled = await changeAccountSecurity(
      tx,
      kv,
      "http://localhost",
      session,
      "ENABLE",
      await proof(tx, kv, session, key, "ENABLE"),
    );
    const grantSession = sessionFor(account.id, "recovery");
    const grant = await createRecoveryRegistrationGrant(
      kv,
      enabled.account,
      grantSession,
    );
    assert.ok(!JSON.stringify([...store.values()]).includes(grant));
    const wrongAction = await proof(tx, kv, session, key, "REGENERATE");
    await assert.rejects(
      changeAccountSecurity(
        tx,
        kv,
        "http://localhost",
        session,
        "DISABLE",
        wrongAction,
      ),
      { code: "INVALID_ASSERTION" },
    );
    await assert.rejects(
      changeAccountSecurity(
        tx,
        kv,
        "http://localhost",
        { ...session, id: crypto.randomUUID() },
        "REGENERATE",
        wrongAction,
      ),
      { code: "INVALID_ASSERTION" },
    );
    for (const [flags, origin] of [
      [1, "http://localhost"],
      [5, "https://evil.example"],
    ] as const) {
      const options = await getSecurityAuthenticationOptions(
        tx,
        kv,
        "http://localhost",
        session,
        "REGENERATE",
      );
      await assert.rejects(
        changeAccountSecurity(
          tx,
          kv,
          "http://localhost",
          session,
          "REGENERATE",
          {
            challengeId: options.challengeId,
            authenticationResponse: key.assertion(
              options.options.challenge,
              flags,
              origin,
            ),
          },
        ),
        { code: "INVALID_ASSERTION" },
      );
    }
    const expired = await proof(tx, kv, session, key, "REGENERATE");
    const record = store.get(
      `account-security/assertion/${expired.challengeId}`,
    ) as { expires: number };
    record.expires = 0;
    await assert.rejects(
      changeAccountSecurity(
        tx,
        kv,
        "http://localhost",
        session,
        "REGENERATE",
        expired,
      ),
      { code: "INVALID_ASSERTION" },
    );
    const rotated = await changeAccountSecurity(
      tx,
      kv,
      "http://localhost",
      session,
      "REGENERATE",
      wrongAction,
    );
    await assert.rejects(
      changeAccountSecurity(
        tx,
        kv,
        "http://localhost",
        session,
        "REGENERATE",
        wrongAction,
      ),
      { code: "INVALID_ASSERTION" },
    );
    assert.equal(
      await consumeRecoveryCode(tx, rotated.account, enabled.recoveryCodes[0]),
      false,
    );
    await assert.rejects(
      consumeRecoveryRegistrationGrant(
        kv,
        rotated.account,
        grantSession,
        grant,
      ),
      { code: "INVALID_ASSERTION" },
    );
    assert.equal(
      await consumeRecoveryCode(
        tx,
        rotated.account,
        rotated.recoveryCodes[0].toLowerCase().replaceAll("-", " "),
      ),
      true,
    );
    assert.equal(
      await consumeRecoveryCode(tx, rotated.account, rotated.recoveryCodes[0]),
      false,
    );
  });
});

test("private security fields, missing keys, last-key guard, strict registration proof and separate recovery grant", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "strictregistration",
      name: "Registration",
      email: "register@example.com",
    });
    const { kv } = createTestKv();
    const session = sessionFor(account.id);
    const guest = makeGuestContext(tx, { kv });
    const owner = makeUserContext(tx, account, { kv, session });
    const query = `query{accountByUsername(username:"${account.username}"){emailLoginEnabled recoveryCodeCount}}`;
    assert.deepEqual(
      toPlainJson((await run(guest, query)).data)?.accountByUsername,
      { emailLoginEnabled: null, recoveryCodeCount: null },
    );
    await assert.rejects(
      getSecurityAuthenticationOptions(
        tx,
        kv,
        "http://localhost",
        session,
        "ENABLE",
      ),
      { code: "PASSKEY_REQUIRED" },
    );
    const key = createWebAuthnCredential();
    await key.insert(tx, account.id);
    const enabled = await changeAccountSecurity(
      tx,
      kv,
      "http://localhost",
      session,
      "ENABLE",
      await proof(tx, kv, session, key, "ENABLE"),
    );
    const revoked = await run(
      owner,
      "mutation($id:ID!){revokePasskey(passkeyId:$id)}",
      { id: encodeGlobalID("Passkey", key.id) },
    );
    assert.equal(revoked.errors?.[0].extensions.code, "LAST_PASSKEY");
    const extra = createWebAuthnCredential();
    const getOptions =
      "mutation($id:ID!){getPasskeyRegistrationOptions(accountId:$id)}";
    const id = encodeGlobalID("Account", account.id);
    const options = toPlainJson((await run(owner, getOptions, { id })).data)
      ?.getPasskeyRegistrationOptions as { challenge: string };
    const register =
      'mutation($id:ID!,$response:JSON!,$grant:String){verifyPasskeyRegistration(accountId:$id,name:"Recovered",registrationResponse:$response,recoveryRegistrationToken:$grant){verified}}';
    const refused = await run(owner, register, {
      id,
      response: extra.registration(options.challenge),
    });
    assert.equal(refused.errors?.[0].extensions.code, "INVALID_ASSERTION");
    const registerWithProof =
      'mutation($id:ID!,$response:JSON!,$challenge:UUID,$assertion:JSON,$grant:String){verifyPasskeyRegistration(accountId:$id,name:"Additional",registrationResponse:$response,securityChallengeId:$challenge,securityAuthenticationResponse:$assertion,recoveryRegistrationToken:$grant){verified}}';
    const additional = createWebAuthnCredential();
    const registerProof = await proof(tx, kv, session, key, "REGISTER");
    for (const partial of [
      { challenge: registerProof.challengeId },
      { assertion: registerProof.authenticationResponse },
    ]) {
      const rejected = await run(owner, registerWithProof, {
        id,
        response: additional.registration(options.challenge),
        ...partial,
      });
      assert.equal(rejected.errors?.[0].extensions.code, "INVALID_ASSERTION");
    }
    assert.ok(
      await kv.get(`account-security/assertion/${registerProof.challengeId}`),
    );
    const added = await run(owner, registerWithProof, {
      id,
      response: additional.registration(options.challenge),
      challenge: registerProof.challengeId,
      assertion: registerProof.authenticationResponse,
    });
    assert.equal(added.errors, undefined);
    assert.equal(
      (
        toPlainJson(added.data)!.verifyPasskeyRegistration as {
          verified: boolean;
        }
      )?.verified,
      true,
    );
    const result = await run(guest, recovery, {
      username: account.username,
      code: enabled.recoveryCodes[0],
    });
    assert.equal(result.errors, undefined);
    const recovered = toPlainJson(result.data)?.loginByRecoveryCode as {
      session: { id: Session["id"] };
      registrationToken: string;
    };
    const recoverySession = await getSession(kv, recovered.session.id);
    assert.ok(recoverySession);
    const recoveryOwner = makeUserContext(tx, account, {
      kv,
      session: recoverySession,
    });
    const recoveryOptions = toPlainJson(
      (await run(recoveryOwner, getOptions, { id })).data,
    )?.getPasskeyRegistrationOptions as { challenge: string };
    const recoveryProof = await proof(tx, kv, recoverySession, key, "REGISTER");
    const combined = await run(recoveryOwner, registerWithProof, {
      id,
      response: extra.registration(recoveryOptions.challenge),
      challenge: recoveryProof.challengeId,
      assertion: recoveryProof.authenticationResponse,
      grant: recovered.registrationToken,
    });
    assert.equal(combined.errors?.[0].extensions.code, "INVALID_ASSERTION");
    assert.ok(
      await kv.get(`account-security/assertion/${recoveryProof.challengeId}`),
    );
    // Invalid attestation and expired options must not burn the recovery grant.
    const invalid = await run(recoveryOwner, register, {
      id,
      response: extra.registration("wrong-challenge"),
      grant: recovered.registrationToken,
    });
    assert.equal(invalid.errors, undefined);
    assert.equal(
      (
        toPlainJson(invalid.data)?.verifyPasskeyRegistration as {
          verified: boolean;
        }
      )?.verified,
      false,
    );
    const expiredOptions = toPlainJson(
      (await run(recoveryOwner, getOptions, { id })).data,
    )?.getPasskeyRegistrationOptions as { challenge: string };
    const registrationKey = `passkey/registration/${account.id}/${recoverySession.id}`;
    const storedOptions = await kv.get(registrationKey);
    assert.ok(storedOptions);
    await kv.set(registrationKey, {
      ...storedOptions,
      expires: Date.now() - 1,
    });
    const expired = await run(recoveryOwner, register, {
      id,
      response: extra.registration(expiredOptions.challenge),
      grant: recovered.registrationToken,
    });
    assert.equal(expired.errors, undefined);
    assert.equal(
      (
        toPlainJson(expired.data)?.verifyPasskeyRegistration as {
          verified: boolean;
        }
      )?.verified,
      false,
    );
    const retryOptions = toPlainJson(
      (await run(recoveryOwner, getOptions, { id })).data,
    )?.getPasskeyRegistrationOptions as { challenge: string };
    const registrationResult = await run(recoveryOwner, register, {
      id,
      response: extra.registration(retryOptions.challenge),
      grant: recovered.registrationToken,
    });
    assert.equal(registrationResult.errors, undefined);
    assert.equal(
      (
        toPlainJson(registrationResult.data)!.verifyPasskeyRegistration as {
          verified: boolean;
        }
      )?.verified,
      true,
    );
    await assert.rejects(
      consumeRecoveryRegistrationGrant(
        kv,
        enabled.account,
        recoverySession,
        recovered.registrationToken,
      ),
      { code: "INVALID_ASSERTION" },
    );
    assert.equal(
      toPlainJson(
        (
          await run(guest, recovery, {
            username: account.username,
            code: enabled.recoveryCodes[0],
          })
        ).data,
      )?.loginByRecoveryCode,
      null,
    );
    const noProof = await run(
      recoveryOwner,
      "mutation($id:ID!){revokePasskey(passkeyId:$id)}",
      { id: encodeGlobalID("Passkey", key.id) },
    );
    assert.equal(noProof.errors?.[0].extensions.code, "INVALID_ASSERTION");
    assert.equal((await tx.select().from(passkeyTable)).length, 3);
  });
});

test("recovery exposes absent peer addresses as null and throttles without consuming the next valid code until the window expires", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "strictthrottle",
      name: "Throttle",
      email: "throttle@example.com",
    });
    const { kv, store } = createTestKv();
    const session = sessionFor(account.id);
    const key = createWebAuthnCredential();
    await key.insert(tx, account.id);
    const enabled = await changeAccountSecurity(
      tx,
      kv,
      "http://localhost",
      session,
      "ENABLE",
      await proof(tx, kv, session, key, "ENABLE"),
    );
    const withAddress =
      "mutation($username:String!,$code:String!){loginByRecoveryCode(username:$username,code:$code){... on RecoveryLoginPayload{session{id ipAddress}}}}";
    for (const [index, connectionInfo] of [
      undefined,
      { remoteAddr: { transport: "unix" } },
    ].entries()) {
      const result = await run(
        makeGuestContext(tx, { kv, connectionInfo }),
        withAddress,
        { username: account.username, code: enabled.recoveryCodes[index] },
      );
      assert.equal(result.errors, undefined);
      const payload = toPlainJson(result.data)!.loginByRecoveryCode as {
        session: { id: Session["id"]; ipAddress: string | null };
      };
      assert.equal(payload.session.ipAddress, null);
      assert.equal(
        (await getSession(kv, payload.session.id))?.ipAddress,
        undefined,
      );
    }
    const guest = makeGuestContext(tx, {
      kv,
      connectionInfo: {
        remoteAddr: { transport: "tcp", hostname: "192.0.2.1", port: 12345 },
      },
    });
    for (let i = 0; i < 10; i++) {
      const invalid = await run(guest, recovery, {
        username: account.username,
        code: "invalid",
      });
      assert.equal(invalid.errors, undefined);
      assert.equal(toPlainJson(invalid.data)?.loginByRecoveryCode, null);
    }
    const attempt = {
      username: account.username,
      code: enabled.recoveryCodes[2],
    };
    const throttled = await run(guest, withAddress, attempt);
    assert.equal(throttled.errors, undefined);
    assert.equal(toPlainJson(throttled.data)?.loginByRecoveryCode, null);
    assert.equal(
      (await tx.select().from(accountRecoveryCodeTable)).filter(
        (row) => row.used != null,
      ).length,
      2,
    );
    for (const [key, value] of store) {
      if (key.startsWith("account-security/recovery-attempts/"))
        store.set(key, { ...(value as object), expires: Date.now() - 1 });
    }
    const retried = await run(guest, withAddress, attempt);
    assert.equal(retried.errors, undefined);
    const payload = toPlainJson(retried.data)!.loginByRecoveryCode as {
      session: { id: Session["id"]; ipAddress: string | null };
    };
    assert.equal(payload.session.ipAddress, "192.0.2.1");
    assert.equal(
      (await getSession(kv, payload.session.id))?.authenticationMethod,
      "recovery",
    );
    assert.equal(
      (await tx.select().from(accountRecoveryCodeTable)).filter(
        (row) => row.used != null,
      ).length,
      3,
    );
  });
});

test("assertions from another account, burned invalid proofs, KV deletion failures, stale sessions, and banned recovery fail closed", async (t) => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "strictfailures",
      name: "Failures",
      email: "failures@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "strictother",
      name: "Other",
      email: "otherstrict@example.com",
    });
    const { kv, store } = createTestKv();
    const session = sessionFor(account.id);
    const key = createWebAuthnCredential();
    await key.insert(tx, account.id);
    const wrongKey = createWebAuthnCredential();
    await wrongKey.insert(tx, other.account.id);
    const options = await getSecurityAuthenticationOptions(
      tx,
      kv,
      "http://localhost",
      session,
      "ENABLE",
    );
    const wrongProof = {
      challengeId: options.challengeId,
      authenticationResponse: wrongKey.assertion(options.options.challenge),
    };
    await assert.rejects(
      changeAccountSecurity(
        tx,
        kv,
        "http://localhost",
        session,
        "ENABLE",
        wrongProof,
      ),
      { code: "INVALID_ASSERTION" },
    );
    assert.equal(
      store.has(`account-security/assertion/${options.challengeId}`),
      false,
    );
    const valid = await proof(tx, kv, session, key, "ENABLE");
    const deletion = t.mock.method(kv, "delete", async () => {
      throw new Error("KV unavailable");
    });
    await assert.rejects(
      changeAccountSecurity(
        tx,
        kv,
        "http://localhost",
        session,
        "ENABLE",
        valid,
      ),
      /KV unavailable/,
    );
    deletion.mock.restore();
    assert.equal(
      (await tx.query.accountTable.findFirst({ where: { id: account.id } }))
        ?.emailLoginEnabled,
      true,
    );
    assert.equal((await tx.select().from(accountRecoveryCodeTable)).length, 0);
    const refusal = t.mock.method(kv, "delete", async () => false);
    await assert.rejects(
      changeAccountSecurity(
        tx,
        kv,
        "http://localhost",
        session,
        "ENABLE",
        valid,
      ),
      { code: "INVALID_ASSERTION" },
    );
    refusal.mock.restore();
    const enabled = await changeAccountSecurity(
      tx,
      kv,
      "http://localhost",
      session,
      "ENABLE",
      valid,
    );
    await assert.rejects(
      getSecurityAuthenticationOptions(
        tx,
        kv,
        "http://localhost",
        { ...session, authenticationMethod: "email" },
        "DISABLE",
      ),
      { code: "NOT_FOUND" },
    );
    const stale = await proof(tx, kv, session, key, "DISABLE");
    await changeAccountSecurity(
      tx,
      kv,
      "http://localhost",
      session,
      "REGENERATE",
      await proof(tx, kv, session, key, "REGENERATE"),
    );
    await assert.rejects(
      changeAccountSecurity(
        tx,
        kv,
        "http://localhost",
        session,
        "DISABLE",
        stale,
      ),
      { code: "INVALID_ASSERTION" },
    );
    // Ban enforcement shares the existing valid-credential error semantics.
    await tx
      .update(actorTable)
      .set({ suspended: new Date(), suspendedUntil: null })
      .where(eq(actorTable.accountId, account.id));
    const currentCode = (
      await changeAccountSecurity(
        tx,
        kv,
        "http://localhost",
        session,
        "REGENERATE",
        await proof(tx, kv, session, key, "REGENERATE"),
      )
    ).recoveryCodes[0];
    const banned = await run(makeGuestContext(tx, { kv }), recovery, {
      username: account.username,
      code: currentCode,
    });
    assert.equal(banned.errors, undefined);
    assert.equal(
      (toPlainJson(banned.data)!.loginByRecoveryCode as { __typename: string })
        .__typename,
      "AccountBannedError",
    );
    assert.equal(enabled.account.emailLoginEnabled, false);
  });
});

test("all five locales deliver credential-free notices", async () => {
  for (const locale of ["en-US", "ja-JP", "ko-KR", "zh-CN", "zh-TW"])
    for (const kind of [
      "emailLoginDisabled",
      "ENABLE",
      "DISABLE",
      "REGENERATE",
    ] as const) {
      const message = await getAccountSecurityMessage({
        from: "noreply@example.com",
        to: "owner@example.com",
        locale: new Intl.Locale(locale),
        username: "<owner>",
        kind,
      });
      assert.ok(message.subject);
      assert.ok(message.content.text);
      assert.ok(
        "html" in message.content &&
          message.content.html?.includes("&lt;owner&gt;"),
      );
      assert.ok(!message.content.text.includes("{{username}}"));
    }
});

// Committed fixtures use the root DB and are cleaned explicitly under the shared
// test lock, so independent API transactions really race on separate connections.
test("concurrent recovery attempts issue one session; concurrent strict revocations retain one key", async () => {
  await withExclusiveTestDatabase(async () => {
    const { account } = await insertAccountWithActor(db as Transaction, {
      username: "strictrace",
      name: "Race",
      email: "strictrace@example.com",
    });
    const { kv } = createTestKv();
    const session = sessionFor(account.id);
    const key = createWebAuthnCredential();
    const extra = createWebAuthnCredential();
    try {
      await key.insert(db, account.id);
      await extra.insert(db, account.id);
      const enabled = await changeAccountSecurity(
        db,
        kv,
        "http://localhost",
        session,
        "ENABLE",
        await proof(db, kv, session, key, "ENABLE"),
      );
      const guest = makeGuestContext(db as Transaction, { kv });
      const results = await Promise.all([
        run(guest, recovery, {
          username: account.username,
          code: enabled.recoveryCodes[0],
        }),
        run(guest, recovery, {
          username: account.username,
          code: enabled.recoveryCodes[0],
        }),
      ]);
      assert.ok(results.every((result) => result.errors == null));
      assert.equal(
        results.filter(
          (result) => toPlainJson(result.data)?.loginByRecoveryCode != null,
        ).length,
        1,
      );
      const proofs = await Promise.all([
        proof(db, kv, session, key, "REVOKE"),
        proof(db, kv, session, key, "REVOKE"),
      ]);
      const revoke =
        "mutation($id:ID!,$challenge:UUID!,$response:JSON!){revokePasskey(passkeyId:$id,securityChallengeId:$challenge,securityAuthenticationResponse:$response)}";
      const revoked = await Promise.all(
        [key, extra].map((credential, index) =>
          run(
            makeUserContext(db as Transaction, account, { kv, session }),
            revoke,
            {
              id: encodeGlobalID("Passkey", credential.id),
              challenge: proofs[index].challengeId,
              response: proofs[index].authenticationResponse,
            },
          ),
        ),
      );
      assert.equal(
        revoked.filter(
          (result) => toPlainJson(result.data)?.revokePasskey != null,
        ).length,
        1,
      );
      assert.equal(
        revoked.filter(
          (result) => result.errors?.[0].extensions.code === "LAST_PASSKEY",
        ).length,
        1,
      );
      assert.equal(
        (
          await db
            .select()
            .from(passkeyTable)
            .where(eq(passkeyTable.accountId, account.id))
        ).length,
        1,
      );
      // The actual HTTP context, rather than a hand-built authenticated context,
      // rejects and deletes legacy/email sessions after strict-mode activation.
      const emailSession = await createSession(kv, {
        accountId: account.id,
        authenticationMethod: "email",
      });
      const yoga = createYogaServer();
      const response = await yoga.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${emailSession.id}`,
          },
          body: JSON.stringify({ query: "{viewer{id}}" }),
        }),
        guest,
      );
      assert.equal((await response.json()).data.viewer, null);
      assert.equal(await getSession(kv, emailSession.id), undefined);
    } finally {
      await db.delete(accountTable).where(eq(accountTable.id, account.id));
    }
  });
});

test("grant deletion failure rolls registration back and leaves a usable retry", async () => {
  await withExclusiveTestDatabase(async () => {
    const { account } = await insertAccountWithActor(db as Transaction, {
      username: "strictgrantretry",
      name: "Grant retry",
      email: "strictgrantretry@example.com",
    });
    const { kv } = createTestKv();
    const key = createWebAuthnCredential();
    const replacement = createWebAuthnCredential();
    const session = sessionFor(account.id);
    const originalDelete = kv.delete.bind(kv);
    try {
      await key.insert(db, account.id);
      const enabled = await changeAccountSecurity(
        db,
        kv,
        "http://localhost",
        session,
        "ENABLE",
        await proof(db, kv, session, key, "ENABLE"),
      );
      const recovered = toPlainJson(
        (
          await run(makeGuestContext(db as Transaction, { kv }), recovery, {
            username: account.username,
            code: enabled.recoveryCodes[0],
          })
        ).data,
      )?.loginByRecoveryCode as {
        session: { id: Session["id"] };
        registrationToken: string;
      };
      const recoverySession = await getSession(kv, recovered.session.id);
      assert.ok(recoverySession);
      const ctx = makeUserContext(db as Transaction, account, {
        kv,
        session: recoverySession,
      });
      const id = encodeGlobalID("Account", account.id);
      const getOptions =
        "mutation($id:ID!){getPasskeyRegistrationOptions(accountId:$id)}";
      const register =
        'mutation($id:ID!,$response:JSON!,$grant:String!){verifyPasskeyRegistration(accountId:$id,name:"Replacement",registrationResponse:$response,recoveryRegistrationToken:$grant){verified}}';
      const options = toPlainJson((await run(ctx, getOptions, { id })).data)
        ?.getPasskeyRegistrationOptions as { challenge: string };
      kv.delete = async (key: string) =>
        key.startsWith("account-security/registration/")
          ? false
          : originalDelete(key);
      const failed = await run(ctx, register, {
        id,
        response: replacement.registration(options.challenge),
        grant: recovered.registrationToken,
      });
      assert.equal(failed.errors?.[0].extensions.code, "INVALID_ASSERTION");
      assert.equal(
        await db.query.passkeyTable.findFirst({
          where: { id: replacement.id },
        }),
        undefined,
      );
      kv.delete = originalDelete;
      const retryOptions = toPlainJson(
        (await run(ctx, getOptions, { id })).data,
      )?.getPasskeyRegistrationOptions as { challenge: string };
      const retried = await run(ctx, register, {
        id,
        response: replacement.registration(retryOptions.challenge),
        grant: recovered.registrationToken,
      });
      assert.equal(retried.errors, undefined);
      assert.equal(
        (
          toPlainJson(retried.data)?.verifyPasskeyRegistration as {
            verified: boolean;
          }
        )?.verified,
        true,
      );
      assert.ok(
        await db.query.passkeyTable.findFirst({
          where: { id: replacement.id },
        }),
      );
    } finally {
      kv.delete = originalDelete;
      await db.delete(accountTable).where(eq(accountTable.id, account.id));
    }
  });
});
