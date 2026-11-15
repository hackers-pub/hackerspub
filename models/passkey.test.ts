import assert from "node:assert";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  getAuthenticationOptions,
  getRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
} from "./passkey.ts";
import { passkeyTable } from "./schema.ts";
import {
  createTestKv,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";
import { createWebAuthnCredential } from "../test/webauthn.ts";

test("getRegistrationOptions() stores a challenge and excludes existing credentials", async () => {
  await withRollback(async (tx) => {
    const { kv, store } = createTestKv();
    const account = await insertAccountWithActor(tx, {
      username: "passkeymodelowner",
      name: "Passkey Model Owner",
      email: "passkeymodelowner@example.com",
    });

    const options = await getRegistrationOptions(
      kv,
      "https://pub.hackers.pub/sign/in",
      {
        ...account.account,
        passkeys: [
          {
            id: "credential-id",
            accountId: account.account.id,
            name: "Laptop",
            publicKey: Buffer.from([1, 2, 3]),
            webauthnUserId: "webauthn-user",
            counter: 0n,
            deviceType: "singleDevice",
            backedUp: false,
            transports: ["internal"],
            lastUsed: null,
            created: new Date("2026-04-15T00:00:00.000Z"),
          },
        ],
      },
    );

    assert.ok(options.challenge.length > 0);
    assert.deepEqual(options.rp.id, "pub.hackers.pub");
    assert.deepEqual(options.user.name, "passkeymodelowner");
    assert.equal(options.authenticatorSelection?.residentKey, "required");
    assert.equal(options.authenticatorSelection?.requireResidentKey, true);
    assert.equal(options.authenticatorSelection?.userVerification, "required");
    assert.deepEqual(options.excludeCredentials, [
      {
        id: "credential-id",
        type: "public-key",
        transports: ["internal"],
      },
    ]);
    assert.ok(store.has(`passkey/registration/${account.account.id}`));
  });
});

test("verifyRegistration() fails when registration options are missing", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const account = await insertAccountWithActor(tx, {
      username: "missingregistration",
      name: "Missing Registration",
      email: "missingregistration@example.com",
    });

    await assert.rejects(
      () =>
        verifyRegistration(
          tx,
          kv,
          ["https://pub.hackers.pub"],
          "pub.hackers.pub",
          account.account,
          "Laptop",
          { id: "credential-id" } as never,
        ),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes(
          `Missing registration options for account ${account.account.id}.`,
        ),
    );
  });
});

test("verifyRegistration() returns unverified for invalid responses", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const account = await insertAccountWithActor(tx, {
      username: "invalidregistration",
      name: "Invalid Registration",
      email: "invalidregistration@example.com",
    });
    await getRegistrationOptions(kv, "https://pub.hackers.pub/sign/in", {
      ...account.account,
      passkeys: [],
    });

    const result = await verifyRegistration(
      tx,
      kv,
      ["https://pub.hackers.pub"],
      "pub.hackers.pub",
      account.account,
      "Laptop",
      { id: "credential-id" } as never,
    );

    assert.equal(result.verified, false);
    assert.equal(result.registrationInfo, undefined);
  });
});

for (const userVerified of [false, true]) {
  test(`verifyRegistration() ${userVerified ? "persists" : "rejects"} a credential with UV=${userVerified}`, async () => {
    await withRollback(async (tx) => {
      const { kv } = createTestKv();
      const account = await insertAccountWithActor(tx, {
        username: "registrationuv",
        name: "Registration UV",
        email: "registrationuv@example.com",
      });
      const origin = "https://pub.hackers.pub";
      const credential = createWebAuthnCredential(origin);
      const options = await getRegistrationOptions(kv, origin, {
        ...account.account,
        passkeys: [],
      });
      // UP and AT stay set in both cases; only UV changes.
      const response = credential.registration(
        options.challenge,
        userVerified ? 0x45 : 0x41,
      );

      const result = await verifyRegistration(
        tx,
        kv,
        [origin],
        "pub.hackers.pub",
        account.account,
        " Laptop ",
        response,
      );

      assert.equal(result.verified, userVerified);
      const stored = await tx.query.passkeyTable.findFirst({
        where: { id: credential.id },
      });
      if (userVerified) {
        assert.equal(stored?.accountId, account.account.id);
        assert.equal(stored?.name, "Laptop");
        assert.equal(stored?.webauthnUserId, options.user.id);
      } else {
        assert.equal(stored, undefined);
      }
    });
  });
}

test("getAuthenticationOptions() stores a challenge for the session", async () => {
  const { kv, store } = createTestKv();
  const sessionId = "019d9162-ffff-7fff-8fff-ffffffffffff";

  const options = await getAuthenticationOptions(
    kv,
    "https://pub.hackers.pub/sign/in",
    sessionId,
  );

  assert.ok(options.challenge.length > 0);
  assert.deepEqual(options.rpId, "pub.hackers.pub");
  assert.equal(options.userVerification, "required");
  assert.ok(
    options.allowCredentials == null || options.allowCredentials.length === 0,
  );
  assert.ok(store.has(`passkey/authentication/${sessionId}`));
});

test("verifyAuthentication() returns undefined for missing options or credentials", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const sessionId = "019d9162-eeee-7eee-8eee-eeeeeeeeeeee";

    const missingOptions = await verifyAuthentication(
      tx,
      kv,
      ["https://pub.hackers.pub"],
      "pub.hackers.pub",
      sessionId,
      { id: "missing-passkey" } as never,
    );
    assert.deepEqual(missingOptions, undefined);

    await getAuthenticationOptions(
      kv,
      "https://pub.hackers.pub/sign/in",
      sessionId,
    );

    const missingPasskey = await verifyAuthentication(
      tx,
      kv,
      ["https://pub.hackers.pub"],
      "pub.hackers.pub",
      sessionId,
      { id: "missing-passkey" } as never,
    );
    assert.deepEqual(missingPasskey, undefined);
  });
});

test("verifyAuthentication() returns undefined when WebAuthn verification throws", async () => {
  await withRollback(async (tx) => {
    const { kv } = createTestKv();
    const sessionId = "019d9163-0000-7000-8000-000000000000";
    const account = await insertAccountWithActor(tx, {
      username: "passkeyverifythrows",
      name: "Passkey Verify Throws",
      email: "passkeyverifythrows@example.com",
    });
    await getAuthenticationOptions(
      kv,
      "https://pub.hackers.pub/sign/in",
      sessionId,
    );
    await tx.insert(passkeyTable).values({
      id: "throwing-credential",
      accountId: account.account.id,
      name: "Broken credential",
      publicKey: Buffer.from([1, 2, 3]),
      webauthnUserId: "throwing-user",
      counter: 0n,
      deviceType: "singleDevice",
      backedUp: false,
      transports: ["internal"],
    });

    const result = await verifyAuthentication(
      tx,
      kv,
      ["https://pub.hackers.pub"],
      "pub.hackers.pub",
      sessionId,
      { id: "throwing-credential" } as never,
    );

    assert.deepEqual(result, undefined);
  });
});

for (const userVerified of [false, true]) {
  test(`verifyAuthentication() ${userVerified ? "accepts" : "rejects"} a signed assertion with UV=${userVerified}`, async () => {
    await withRollback(async (tx) => {
      const { kv } = createTestKv();
      const account = await insertAccountWithActor(tx, {
        username: "authenticationuv",
        name: "Authentication UV",
        email: "authenticationuv@example.com",
      });
      const origin = "https://pub.hackers.pub";
      const sessionId = "019d9163-0000-7000-8000-000000000001";
      const credential = createWebAuthnCredential(origin);
      await credential.insert(tx, account.account.id);
      const options = await getAuthenticationOptions(kv, origin, sessionId);

      const result = await verifyAuthentication(
        tx,
        kv,
        [origin],
        "pub.hackers.pub",
        sessionId,
        credential.assertion(options.challenge, userVerified ? 0x05 : 0x01),
      );

      const stored = await tx.query.passkeyTable.findFirst({
        where: { id: credential.id },
      });
      if (userVerified) {
        assert.equal(result?.response.verified, true);
        assert.equal(result?.response.authenticationInfo.userVerified, true);
        assert.equal(result?.account.id, account.account.id);
        assert.ok(stored?.lastUsed instanceof Date);
      } else {
        assert.equal(result, undefined);
        assert.equal(stored?.lastUsed, null);
      }
    });
  });
}
