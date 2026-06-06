import assert from "node:assert";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  MAX_PUSH_NOTIFICATION_TARGETS_PER_SERVICE,
  registerPushNotificationTarget,
  unregisterPushNotificationTarget,
} from "./push.ts";
import { pushNotificationTargetTable } from "./schema.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";

function webSubscription(endpoint: string) {
  return {
    endpoint,
    p256dh:
      "BAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    auth: "AgICAgICAgICAgICAgICAg",
    expirationTime: null,
  };
}

test("registerPushNotificationTarget() rejects unsafe Web Push subscriptions", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "pushunsafe",
      name: "Push Unsafe",
      email: "pushunsafe@example.com",
    });

    for (
      const subscription of [
        webSubscription("http://push.example/endpoint"),
        webSubscription("https://127.0.0.1/endpoint"),
        webSubscription("https://[::ffff:127.0.0.1]/endpoint"),
        webSubscription("https://[::ffff:169.254.169.254]/endpoint"),
        webSubscription("https://[::ffff:7f00:1]/endpoint"),
        { ...webSubscription("https://push.example/endpoint"), p256dh: "@@" },
        { ...webSubscription("https://push.example/endpoint"), auth: "@@" },
        {
          ...webSubscription("https://push.example/endpoint"),
          p256dh: "dG9vLXNob3J0",
        },
        {
          ...webSubscription("https://push.example/endpoint"),
          auth: "dG9vLXNob3J0",
        },
      ]
    ) {
      assert.equal(
        await registerPushNotificationTarget(tx, account.id, {
          service: "web_push",
          subscription,
        }),
        undefined,
      );
    }

    const stored = await tx.select().from(pushNotificationTargetTable)
      .where(eq(pushNotificationTargetTable.accountId, account.id));
    assert.deepEqual(stored, []);
  });
});

test("registerPushNotificationTarget() reassigns an existing Web Push endpoint", async () => {
  await withRollback(async (tx) => {
    const first = await insertAccountWithActor(tx, {
      username: "pushfirst",
      name: "Push First",
      email: "pushfirst@example.com",
    });
    const second = await insertAccountWithActor(tx, {
      username: "pushsecond",
      name: "Push Second",
      email: "pushsecond@example.com",
    });
    const endpoint = "https://push.example/endpoint/reassign";

    await registerPushNotificationTarget(tx, first.account.id, {
      service: "web_push",
      subscription: webSubscription(endpoint),
    });
    const reassigned = await registerPushNotificationTarget(
      tx,
      second.account.id,
      {
        service: "web_push",
        subscription: webSubscription(endpoint),
      },
    );

    assert.ok(reassigned != null);
    assert.equal(reassigned.accountId, second.account.id);

    const stored = await tx.select().from(pushNotificationTargetTable)
      .where(eq(pushNotificationTargetTable.endpoint, endpoint));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].accountId, second.account.id);
  });
});

test("registerPushNotificationTarget() evicts the oldest Web Push endpoint per account", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "pushlimit",
      name: "Push Limit",
      email: "pushlimit@example.com",
    });

    const firstEndpoint = "https://push.example/endpoint/1";
    for (let i = 0; i < MAX_PUSH_NOTIFICATION_TARGETS_PER_SERVICE; i++) {
      const endpoint = `https://push.example/endpoint/${i + 1}`;
      await registerPushNotificationTarget(tx, account.id, {
        service: "web_push",
        subscription: webSubscription(endpoint),
      });
    }

    await tx.update(pushNotificationTargetTable)
      .set({ updated: new Date("2000-01-01T00:00:00Z") })
      .where(eq(pushNotificationTargetTable.endpoint, firstEndpoint));

    const extraEndpoint = "https://push.example/endpoint/extra";
    await registerPushNotificationTarget(tx, account.id, {
      service: "web_push",
      subscription: webSubscription(extraEndpoint),
    });

    const endpoints = await tx.select({
      endpoint: pushNotificationTargetTable.endpoint,
    }).from(pushNotificationTargetTable)
      .where(
        and(
          eq(pushNotificationTargetTable.accountId, account.id),
          eq(pushNotificationTargetTable.service, "web_push"),
        ),
      );
    assert.equal(endpoints.length, MAX_PUSH_NOTIFICATION_TARGETS_PER_SERVICE);
    assert.ok(endpoints.some((row) => row.endpoint === extraEndpoint));
    assert.ok(!endpoints.some((row) => row.endpoint === firstEndpoint));
  });
});

test("unregisterPushNotificationTarget() only removes Web Push endpoints owned by the account", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "pushowner",
      name: "Push Owner",
      email: "pushowner@example.com",
    });
    const other = await insertAccountWithActor(tx, {
      username: "pushother",
      name: "Push Other",
      email: "pushother@example.com",
    });
    const endpoint = "https://push.example/endpoint/remove";

    await registerPushNotificationTarget(tx, owner.account.id, {
      service: "web_push",
      subscription: webSubscription(endpoint),
    });

    assert.equal(
      await unregisterPushNotificationTarget(tx, other.account.id, {
        service: "web_push",
        endpoint,
      }),
      false,
    );
    assert.equal(
      await unregisterPushNotificationTarget(tx, owner.account.id, {
        service: "web_push",
        endpoint,
      }),
      true,
    );

    const stored = await tx.select().from(pushNotificationTargetTable)
      .where(eq(pushNotificationTargetTable.endpoint, endpoint));
    assert.deepEqual(stored, []);
  });
});
