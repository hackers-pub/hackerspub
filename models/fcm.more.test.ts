import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import type { Database } from "./db.ts";
import { resetFcmStateForTesting, sendFcmNotification } from "./fcm.ts";
import { pushNotificationTargetTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";

async function buildServiceAccountJson(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(pkcs8)));
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    b64.match(/.{1,64}/g)!.join("\n")
  }\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({
    project_id: "test-project",
    client_email: "sa@test-project.iam.gserviceaccount.com",
    private_key: pem,
  });
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

test("sendFcmNotification dispatches per-token requests concurrently and prunes stale tokens", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GOOGLE_SERVICES_JSON_BASE64;

  process.env.GOOGLE_SERVICES_JSON_BASE64 = btoa(
    await buildServiceAccountJson(),
  );
  resetFcmStateForTesting();

  const staleToken = "fcm-stale-token";
  const misconfiguredToken = "fcm-misconfigured-404-token";
  const invalidArgumentToken = "fcm-invalid-argument-token";
  const activeTokens = [
    "fcm-active-1",
    "fcm-active-2",
    "fcm-active-3",
    "fcm-active-4",
    misconfiguredToken,
    invalidArgumentToken,
  ];
  const allTokens = [...activeTokens, staleToken];

  let inFlight = 0;
  let maxInFlight = 0;
  const sentTokens: string[] = [];

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = resolveUrl(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({ access_token: "fake-token", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("https://fcm.googleapis.com/")) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        const body = JSON.parse(String(init?.body ?? "{}"));
        const token = body?.message?.token as string;
        sentTokens.push(token);
        if (token === staleToken) {
          return new Response(
            JSON.stringify({
              error: {
                status: "NOT_FOUND",
                details: [{ errorCode: "UNREGISTERED" }],
              },
            }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (token === misconfiguredToken) {
          return new Response(
            JSON.stringify({ error: { status: "NOT_FOUND" } }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        if (token === invalidArgumentToken) {
          return new Response(
            JSON.stringify({
              error: {
                status: "INVALID_ARGUMENT",
                details: [{ errorCode: "INVALID_ARGUMENT" }],
              },
            }),
            {
              status: 400,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({ name: "projects/test-project/messages/abc" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      } finally {
        inFlight--;
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    await withRollback(async (tx) => {
      const { account } = await insertAccountWithActor(tx, {
        username: "fcmparallel",
        name: "FCM Parallel",
        email: "fcmparallel@example.com",
      });

      for (const deviceToken of allTokens) {
        await tx.insert(pushNotificationTargetTable).values({
          id: generateUuidV7(),
          accountId: account.id,
          service: "fcm",
          token: deviceToken,
        });
      }

      await sendFcmNotification(tx, {
        accountId: account.id,
        notificationId: generateUuidV7(),
        type: "follow",
        actorId: generateUuidV7(),
      });

      assert.equal(sentTokens.length, allTokens.length);
      assert.deepEqual(
        new Set(sentTokens),
        new Set(allTokens),
      );
      assert.ok(
        maxInFlight > 1,
        `expected concurrent dispatch, observed maxInFlight=${maxInFlight}`,
      );

      const remaining = await tx.select({
        token: pushNotificationTargetTable.token,
      }).from(pushNotificationTargetTable)
        .where(
          and(
            eq(pushNotificationTargetTable.accountId, account.id),
            eq(pushNotificationTargetTable.service, "fcm"),
          ),
        );
      const remainingSet = new Set(remaining.map((row) => row.token));
      assert.ok(
        !remainingSet.has(staleToken),
        "expected UNREGISTERED token to be pruned",
      );
      for (const activeToken of activeTokens) {
        assert.ok(
          remainingSet.has(activeToken),
          `expected ${activeToken} to remain`,
        );
      }
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.GOOGLE_SERVICES_JSON_BASE64;
    } else {
      process.env.GOOGLE_SERVICES_JSON_BASE64 = originalKey;
    }
    resetFcmStateForTesting();
  }
});

test("sendFcmNotification is a no-op when GOOGLE_SERVICES_JSON_BASE64 lacks a private key", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GOOGLE_SERVICES_JSON_BASE64;

  // An Android `google-services.json` client config: it parses as valid JSON
  // but has no `private_key`/`client_email`. Feeding it to the env var is the
  // misconfiguration that caused `TypeError: Cannot read properties of
  // undefined (reading 'replace')` (Sentry GRAPHQL-1E). It must now be
  // rejected without throwing and without any network or database access.
  const googleServicesJson = JSON.stringify({
    project_info: {
      project_number: "123456789000",
      project_id: "test-project",
      storage_bucket: "test-project.appspot.com",
    },
    client: [
      {
        client_info: { mobilesdk_app_id: "1:123456789000:android:abcdef" },
        api_key: [{ current_key: "AIzaTESTKEY" }],
      },
    ],
    configuration_version: "1",
  });
  process.env.GOOGLE_SERVICES_JSON_BASE64 = btoa(googleServicesJson);
  resetFcmStateForTesting();

  let fetchCalled = false;
  globalThis.fetch = ((): Promise<Response> => {
    fetchCalled = true;
    throw new Error("fetch must not be called when FCM is misconfigured");
  }) as typeof fetch;
  const db = new Proxy({}, {
    get() {
      throw new Error("db must not be accessed when FCM is misconfigured");
    },
  }) as unknown as Database;

  try {
    await sendFcmNotification(db, {
      accountId: generateUuidV7(),
      notificationId: generateUuidV7(),
      type: "react",
      actorId: generateUuidV7(),
      postId: generateUuidV7(),
      emoji: "👍",
    });
    assert.equal(fetchCalled, false, "expected no network call");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) {
      delete process.env.GOOGLE_SERVICES_JSON_BASE64;
    } else {
      process.env.GOOGLE_SERVICES_JSON_BASE64 = originalKey;
    }
    resetFcmStateForTesting();
  }
});
