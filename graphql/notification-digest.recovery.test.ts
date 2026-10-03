import assert from "node:assert/strict";
import test from "node:test";
import type { Database, Transaction } from "@hackerspub/models/db";
import {
  accountEmailTable,
  accountTable,
  notificationDigestDeliveryTable,
  notificationTable,
  postTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import type { Message, Transport } from "@upyo/core";
import { eq, inArray } from "drizzle-orm";
import { db } from "../test/database.ts";
import {
  createTestEmailTransport,
  insertAccountWithActor,
  withExclusiveTestDatabase,
} from "../test/postgres.ts";
import {
  sendNotificationDigests,
  withNotificationDigestGuard,
} from "./notification-digest.ts";

const tick = new Date("2026-10-06T00:05:00Z");

async function withDigestAccount(
  run: (
    fixture: Awaited<ReturnType<typeof insertAccountWithActor>>,
  ) => Promise<void>,
) {
  await withExclusiveTestDatabase(async () => {
    const fixture = await insertAccountWithActor(db as Transaction, {
      username: "digestrecovery",
      name: "Recovery",
      email: "digestrecovery@example.com",
    });
    try {
      await db
        .update(accountTable)
        .set({
          notificationEmailDigestDaily: true,
          notificationEmailDigestWeekly: false,
        })
        .where(eq(accountTable.id, fixture.account.id));
      await db.insert(notificationTable).values({
        id: generateUuidV7(),
        accountId: fixture.account.id,
        type: "follow",
        actorIds: [fixture.actor.id],
        created: new Date("2026-10-05T12:00:00Z"),
      });
      await run(fixture);
    } finally {
      await db
        .delete(accountTable)
        .where(eq(accountTable.id, fixture.account.id));
    }
  });
}

function options(email: Transport, database = db) {
  return {
    db: database,
    email,
    from: "notifications@example.com",
    origin: "https://example.com",
    frequency: "daily" as const,
    now: tick,
  };
}

/** Fail independently committed delivery updates, never the guard transaction. */
function failingUpdates(
  fail: (values: Record<string, unknown>) => boolean,
): Database {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "update") return Reflect.get(target, property, receiver);
      return (table: typeof notificationDigestDeliveryTable) => {
        const update = target.update(table);
        return {
          set(values: Record<string, unknown>) {
            if (!fail(values)) return update.set(values);
            return {
              async where() {
                throw new Error("Controlled progress write failure");
              },
            };
          },
        };
      };
    },
  });
}

test("delayed digest retries keep cutoff/period and reclaim fresh orphan claims immediately", async () => {
  await withDigestAccount(async ({ account, actor }) => {
    const postId = generateUuidV7();
    await db.insert(postTable).values({
      id: postId,
      iri: `https://example.com/objects/${postId}`,
      type: "Note",
      visibility: "public",
      actorId: actor.id,
      contentHtml: "<p>Later notification</p>",
      language: "en",
      tags: {},
      emojis: {},
      published: new Date(),
      updated: new Date(),
    });
    await db.insert(notificationTable).values({
      id: generateUuidV7(),
      accountId: account.id,
      type: "react",
      postId,
      actorIds: [actor.id],
      emoji: "👍",
      created: new Date("2026-10-07T00:01:00Z"),
    });
    await db.insert(notificationDigestDeliveryTable).values({
      accountId: account.id,
      frequency: "daily",
      periodStart: new Date("2026-10-06T00:00:00Z"),
      notificationsCount: 2,
      created: new Date(),
    });
    const email = createTestEmailTransport();
    const result = await sendNotificationDigests(options(email.transport));
    assert.equal(result.emailsSent, 1);
    const [delivery] = await db
      .select()
      .from(notificationDigestDeliveryTable)
      .where(eq(notificationDigestDeliveryTable.accountId, account.id));
    // Reclaim refreshes the live unread snapshot, bounded by the original tick.
    assert.equal(delivery.notificationsCount, 1);
    assert.equal(
      delivery.periodStart.toISOString(),
      "2026-10-06T00:00:00.000Z",
    );
    assert.match((email.messages[0] as Message).subject, /1 unread/);
    assert.equal(
      (await sendNotificationDigests(options(email.transport))).emailsSent,
      0,
    );
  });
});

test("a failed completion write preserves accepted recipients through guard rollback/retry", async () => {
  await withDigestAccount(async ({ account }) => {
    const email = createTestEmailTransport();
    const database = failingUpdates((values) => "sent" in values);
    const failed = await sendNotificationDigests(
      options(email.transport, database),
    );
    assert.equal(failed.accountsFailed, 1);
    const [delivery] = await db
      .select()
      .from(notificationDigestDeliveryTable)
      .where(eq(notificationDigestDeliveryTable.accountId, account.id));
    assert.deepEqual(delivery.sentRecipients, ["digestrecovery@example.com"]);
    assert(delivery.failed);
    const retry = await sendNotificationDigests(options(email.transport));
    assert.equal(retry.emailsSent, 0);
    assert.equal(email.messages.length, 1);
    assert(
      (
        await db
          .select()
          .from(notificationDigestDeliveryTable)
          .where(eq(notificationDigestDeliveryTable.accountId, account.id))
      )[0].sent,
    );
  });
});

test("failure of both recipient progress and failure writes is retryable and may duplicate email", async () => {
  await withDigestAccount(async ({ account }) => {
    const email = createTestEmailTransport();
    const result = await sendNotificationDigests(
      options(
        email.transport,
        failingUpdates(() => true),
      ),
    );
    assert.equal(result.accountsFailed, 1);
    const [orphan] = await db
      .select()
      .from(notificationDigestDeliveryTable)
      .where(eq(notificationDigestDeliveryTable.accountId, account.id));
    assert.equal(orphan.sent, null);
    assert.deepEqual(orphan.sentRecipients, []);
    assert.equal(email.messages.length, 1);
    assert.equal(
      (await sendNotificationDigests(options(email.transport))).emailsSent,
      1,
    );
    // This is the explicitly documented send/save ambiguity, not exactly once.
    assert.equal(email.messages.length, 2);
  });
});

test("failed recipient progress and failure writes do not skip later accounts", async () => {
  await withDigestAccount(async ({ account }) => {
    const second = await insertAccountWithActor(db as Transaction, {
      username: "digestlater",
      name: "Later account",
      email: "digestlater@example.com",
    });
    try {
      await db
        .update(accountTable)
        .set({ notificationEmailDigestDaily: true })
        .where(eq(accountTable.id, second.account.id));
      await db.insert(notificationTable).values({
        id: generateUuidV7(),
        accountId: second.account.id,
        type: "follow",
        actorIds: [second.actor.id],
        created: new Date("2026-10-05T12:00:00Z"),
      });
      let writes = 0;
      const database = failingUpdates(() => writes++ < 2);
      const email = createTestEmailTransport();
      const result = await sendNotificationDigests(
        options(email.transport, database),
      );
      assert.equal(result.accountsClaimed, 2);
      assert.equal(result.accountsFailed, 1);
      assert.equal(result.emailsSent, 2);
      const deliveries = await db
        .select()
        .from(notificationDigestDeliveryTable)
        .where(
          inArray(notificationDigestDeliveryTable.accountId, [
            account.id,
            second.account.id,
          ]),
        );
      assert.equal(
        deliveries.filter((delivery) => delivery.sent != null).length,
        1,
      );
      assert.equal(
        deliveries.filter((delivery) => delivery.sent == null).length,
        1,
      );
      assert.equal(
        (await sendNotificationDigests(options(email.transport))).emailsSent,
        1,
      );
      assert.equal(email.messages.length, 3);
      // Only the account whose two state writes failed may be sent again.
      assert.equal(
        new Set(
          email.messages.map(
            (message) => (message as Message).recipients[0].address,
          ),
        ).size,
        2,
      );
    } finally {
      await db
        .delete(accountTable)
        .where(eq(accountTable.id, second.account.id));
    }
  });
});

test("partial transport failure retries only remaining recipients using autocommit progress", async () => {
  await withDigestAccount(async ({ account }) => {
    await db
      .update(accountEmailTable)
      .set({ primary: false })
      .where(eq(accountEmailTable.accountId, account.id));
    await db.insert(accountEmailTable).values({
      accountId: account.id,
      email: "digestbackup@example.com",
      verified: new Date(),
      primary: false,
    });
    const attempted: string[] = [];
    let failing = true;
    const email = {
      async send(message: Message) {
        const to = message.recipients[0].address;
        attempted.push(to);
        return {
          successful: !(failing && to === "digestbackup@example.com"),
          errorMessages:
            failing && to === "digestbackup@example.com"
              ? ["temporary outage"]
              : [],
        };
      },
    } as unknown as Transport;
    assert.equal(
      (await sendNotificationDigests(options(email))).accountsFailed,
      1,
    );
    failing = false;
    assert.equal((await sendNotificationDigests(options(email))).emailsSent, 1);
    assert.equal(
      attempted.filter((to) => to === "digestrecovery@example.com").length,
      1,
    );
    assert.equal(
      attempted.filter((to) => to === "digestbackup@example.com").length,
      2,
    );
  });
});

test("canceling between recipients preserves progress without recording a delivery failure", async () => {
  await withDigestAccount(async ({ account }) => {
    await db
      .update(accountEmailTable)
      .set({ primary: false })
      .where(eq(accountEmailTable.accountId, account.id));
    await db.insert(accountEmailTable).values({
      accountId: account.id,
      email: "digestbackup@example.com",
      verified: new Date(),
      primary: false,
    });
    const controller = new AbortController();
    let sends = 0;
    const email = {
      async send() {
        sends++;
        controller.abort();
        return { successful: true, errorMessages: [] };
      },
    } as unknown as Transport;
    await assert.rejects(
      sendNotificationDigests({
        ...options(email),
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    const [delivery] = await db
      .select()
      .from(notificationDigestDeliveryTable)
      .where(eq(notificationDigestDeliveryTable.accountId, account.id));
    assert.equal(delivery.sent, null);
    assert.equal(delivery.failed, null);
    assert.equal(delivery.error, null);
    assert.equal(delivery.sentRecipients.length, 1);
    assert.equal(sends, 1);
    assert.equal((await sendNotificationDigests(options(email))).emailsSent, 1);
    assert.equal(sends, 2);
  });
});

test("a canceled handler keeps its guard until an in-flight send and progress drain", async () => {
  await withDigestAccount(async () => {
    const controller = new AbortController();
    const sending = Promise.withResolvers<void>();
    const sent = Promise.withResolvers<void>();
    let sends = 0;
    const email = {
      async send() {
        sends++;
        sending.resolve();
        await sent.promise;
        return { successful: true, errorMessages: [] };
      },
    } as unknown as Transport;
    const first = sendNotificationDigests({
      ...options(email),
      signal: controller.signal,
    });
    // Attach the rejection observer before aborting so test failures can't leak.
    const rejected = assert.rejects(first, { name: "AbortError" });
    await sending.promise;
    controller.abort();
    const second = sendNotificationDigests(options(email));
    let completed = false;
    const observed = second.then((result) => {
      completed = true;
      return result;
    });
    try {
      // A second root-db sender must fail a bounded lock acquisition while the
      // first drains, even though its execution signal has already aborted.
      await assert.rejects(
        withNotificationDigestGuard(
          db,
          "daily",
          undefined,
          async () => undefined,
          { waitMilliseconds: 20, pollMilliseconds: 1 },
        ),
        /Timed out/,
      );
      assert.equal(completed, false);
      assert.equal(sends, 1);
    } finally {
      sent.resolve();
    }
    await rejected;
    const result = await observed;
    assert.equal(result.emailsSent, 0);
    assert.equal(sends, 1);
  });
});

test("digest guard contention has a bounded wait and supports prompt cancellation", async () => {
  await withExclusiveTestDatabase(async () => {
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = withNotificationDigestGuard(
      db,
      "weekly",
      undefined,
      async () => {
        acquired.resolve();
        await release.promise;
      },
    );
    await acquired.promise;
    try {
      await assert.rejects(
        withNotificationDigestGuard(
          db,
          "weekly",
          undefined,
          async () => undefined,
          { waitMilliseconds: 10, pollMilliseconds: 1 },
        ),
        /Timed out/,
      );
      const controller = new AbortController();
      const waiting = withNotificationDigestGuard(
        db,
        "weekly",
        controller.signal,
        async () => undefined,
      );
      const rejected = assert.rejects(waiting, { name: "AbortError" });
      controller.abort();
      await rejected;
    } finally {
      release.resolve();
      await holder;
    }
    await withNotificationDigestGuard(
      db,
      "weekly",
      undefined,
      async (verify) => await verify(),
    );
  });
});
