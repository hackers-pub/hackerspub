import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { resetFcmStateForTesting, sendFcmNotification } from "./fcm.ts";
import { fcmDeviceTokenTable } from "./schema.ts";
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
  const originalKey = process.env.FCM_SERVICE_ACCOUNT_KEY;

  process.env.FCM_SERVICE_ACCOUNT_KEY = await buildServiceAccountJson();
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
        await tx.insert(fcmDeviceTokenTable).values({
          accountId: account.id,
          deviceToken,
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

      const remaining = await tx.query.fcmDeviceTokenTable.findMany({
        where: { accountId: account.id },
        columns: { deviceToken: true },
      });
      const remainingSet = new Set(remaining.map((row) => row.deviceToken));
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
      delete process.env.FCM_SERVICE_ACCOUNT_KEY;
    } else {
      process.env.FCM_SERVICE_ACCOUNT_KEY = originalKey;
    }
    resetFcmStateForTesting();
  }
});
