import assert from "node:assert";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
  getAuthenticationOptions,
  getRegistrationOptions,
  resolvePasskeyOrigins,
  verifyAuthentication,
  verifyRegistration,
} from "./passkey.ts";
import {
  createTestKv,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";

test("resolvePasskeyOrigins() prefers platform-specific origins", () => {
  assert.deepEqual(
    resolvePasskeyOrigins("https://pub.hackers.pub/sign/in", "web"),
    ["https://pub.hackers.pub"],
  );
  assert.deepEqual(
    resolvePasskeyOrigins("https://pub.hackers.pub/sign/in", "ios"),
    ["ios:pub.hackers.HackersPub"],
  );
  assert.deepEqual(
    resolvePasskeyOrigins("https://pub.hackers.pub/sign/in", "android"),
    [
      "android:apk-key-hash:UqAUIQLNMP2LKaPtgCsKvq-rNyl5OYQat545Ba9k1Ro",
      "android:apk-key-hash:yqSW6UZsaCl_dADWM0X3C_ndgblJU4uUMrjQYLIxEFs",
    ],
  );
});

test(
  "getRegistrationOptions() stores a challenge and excludes existing credentials",
  async () => {
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
      assert.deepEqual(options.excludeCredentials, [{
        id: "credential-id",
        type: "public-key",
        transports: ["internal"],
      }]);
      assert.ok(store.has(`passkey/registration/${account.account.id}`));
    });
  },
);

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
  assert.ok(store.has(`passkey/authentication/${sessionId}`));
});

test(
  "verifyAuthentication() returns undefined for missing options or credentials",
  async () => {
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
  },
);
