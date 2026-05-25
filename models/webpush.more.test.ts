import assert from "node:assert/strict";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import { registerPushNotificationTarget } from "./push.ts";
import { pushNotificationTargetTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  sendWebPushNotification,
  setWebPushConfigForTesting,
  setWebPushSenderForTesting,
} from "./webpush.ts";
import {
  insertAccountWithActor,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

test("sendWebPushNotification() sends browser subscriptions and prunes stale endpoints", async () => {
  const sent: Array<{ endpoint: string; payload: string }> = [];
  setWebPushConfigForTesting({
    publicKey: "test-public-key",
    privateKey: "test-private-key",
    subject: "mailto:test@example.com",
  });
  setWebPushSenderForTesting(async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, payload });
    if (subscription.endpoint.endsWith("/stale")) {
      throw { statusCode: 410 };
    }
  });

  try {
    await withRollback(async (tx) => {
      const { account } = await insertAccountWithActor(tx, {
        username: "webpush",
        name: "Web Push",
        email: "webpush@example.com",
      });
      const actor = await insertRemoteActor(tx, {
        username: "sender",
        name: "Sender",
        host: "remote.example",
      });
      const activeEndpoint = "https://push.example/active";
      const staleEndpoint = "https://push.example/stale";
      const unsafeEndpoint = "https://127.0.0.1/rebound";

      for (const endpoint of [activeEndpoint, staleEndpoint]) {
        await registerPushNotificationTarget(tx, account.id, {
          service: "web_push",
          subscription: {
            endpoint,
            p256dh: "dGVzdC1wMjU2ZGg",
            auth: "dGVzdC1hdXRo",
          },
        });
      }
      await tx.insert(pushNotificationTargetTable).values({
        id: generateUuidV7(),
        service: "web_push",
        accountId: account.id,
        endpoint: unsafeEndpoint,
        p256dh: "dGVzdC1wMjU2ZGg",
        auth: "dGVzdC1hdXRo",
      });

      await sendWebPushNotification(tx, {
        accountId: account.id,
        notificationId: generateUuidV7(),
        type: "follow",
        actorId: actor.id,
      });

      assert.deepEqual(
        new Set(sent.map((entry) => entry.endpoint)),
        new Set([activeEndpoint, staleEndpoint]),
      );
      assert.equal(JSON.parse(sent[0].payload).url, "/notifications");

      const remaining = await tx.select({
        endpoint: pushNotificationTargetTable.endpoint,
      }).from(pushNotificationTargetTable)
        .where(
          and(
            eq(pushNotificationTargetTable.accountId, account.id),
            eq(pushNotificationTargetTable.service, "web_push"),
          ),
        );
      assert.deepEqual(remaining.map((row) => row.endpoint), [
        activeEndpoint,
      ]);
    });
  } finally {
    setWebPushConfigForTesting(undefined);
    setWebPushSenderForTesting(undefined);
  }
});
