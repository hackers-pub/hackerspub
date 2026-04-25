import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { assertRejects } from "@std/assert/rejects";
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

Deno.test("resolvePasskeyOrigins() prefers platform-specific origins", () => {
  assertEquals(
    resolvePasskeyOrigins("https://pub.hackers.pub/sign/in", "web"),
    ["https://pub.hackers.pub"],
  );
  assertEquals(
    resolvePasskeyOrigins("https://pub.hackers.pub/sign/in", "ios"),
    ["https://pub.hackers.pub"],
  );
  assertEquals(
    resolvePasskeyOrigins("https://pub.hackers.pub/sign/in", "android"),
    [
      "android:apk-key-hash:UqAUIQLNMP2LKaPtgCsKvq-rNyl5OYQat545Ba9k1Ro",
      "android:apk-key-hash:yqSW6UZsaCl_dADWM0X3C_ndgblJU4uUMrjQYLIxEFs",
    ],
  );
});

Deno.test({
  name:
    "getRegistrationOptions() stores a challenge and excludes existing credentials",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assert(options.challenge.length > 0);
      assertEquals(options.rp.id, "pub.hackers.pub");
      assertEquals(options.user.name, "passkeymodelowner");
      assertEquals(options.excludeCredentials, [{
        id: "credential-id",
        type: "public-key",
        transports: ["internal"],
      }]);
      assert(store.has(`passkey/registration/${account.account.id}`));
    });
  },
});

Deno.test({
  name: "verifyRegistration() fails when registration options are missing",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const { kv } = createTestKv();
      const account = await insertAccountWithActor(tx, {
        username: "missingregistration",
        name: "Missing Registration",
        email: "missingregistration@example.com",
      });

      await assertRejects(
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
        Error,
        `Missing registration options for account ${account.account.id}.`,
      );
    });
  },
});

Deno.test({
  name: "getAuthenticationOptions() stores a challenge for the session",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { kv, store } = createTestKv();
    const sessionId = "019d9162-ffff-7fff-8fff-ffffffffffff";

    const options = await getAuthenticationOptions(
      kv,
      "https://pub.hackers.pub/sign/in",
      sessionId,
    );

    assert(options.challenge.length > 0);
    assertEquals(options.rpId, "pub.hackers.pub");
    assert(store.has(`passkey/authentication/${sessionId}`));
  },
});

Deno.test({
  name:
    "verifyAuthentication() returns undefined for missing options or credentials",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
      assertEquals(missingOptions, undefined);

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
      assertEquals(missingPasskey, undefined);
    });
  },
});
