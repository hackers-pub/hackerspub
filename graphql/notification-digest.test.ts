import assert from "node:assert";
import test from "node:test";
import { createActionTakenNotification } from "@hackerspub/models/moderation-notification";
import {
  accountEmailTable,
  accountTable,
  flagActionTable,
  flagCaseTable,
  notificationDigestDeliveryTable,
  notificationTable,
  organizationMembershipTable,
  organizationNotificationReadTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import type { Message } from "@upyo/core";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import {
  getNotificationDigestPeriodStart,
  sendNotificationDigests,
} from "./notification-digest.ts";
import { schema } from "./mod.ts";
import {
  createTestEmailTransport,
  insertAccountWithActor,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const updateDigestSettingsMutation = parse(`
  mutation UpdateDigestSettings($id: ID!, $daily: Boolean!, $weekly: Boolean!) {
    updateNotificationEmailDigestSettings(input: {
      id: $id,
      daily: $daily,
      weekly: $weekly
    }) {
      account {
        notificationEmailDigestDaily
        notificationEmailDigestWeekly
      }
    }
  }
`);

test(
  "sendNotificationDigests sends one daily digest across unread notification sources",
  async () => {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "digestuser",
        name: "Digest User",
        email: "digestuser@example.com",
      });
      const actor = await insertAccountWithActor(tx, {
        username: "digestactor",
        name: "Digest Actor",
        email: "digestactor@example.com",
      });
      const moderator = await insertAccountWithActor(tx, {
        username: "digestmod",
        name: "Digest Moderator",
        email: "digestmod@example.com",
      });
      const organization = await insertAccountWithActor(tx, {
        username: "digestorg",
        name: "Digest Org",
        email: "digestorg@example.com",
        kind: "organization",
        type: "Organization",
      });
      const otherMember = await insertAccountWithActor(tx, {
        username: "digestmember",
        name: "Digest Member",
        email: "digestmember@example.com",
      });
      await tx.update(accountTable).set({
        notificationEmailDigestDaily: false,
      }).where(eq(accountTable.id, otherMember.account.id));

      await tx.insert(notificationTable).values({
        id: generateUuidV7(),
        accountId: account.account.id,
        type: "follow",
        actorIds: [actor.actor.id],
        created: new Date("2026-06-29T12:00:00.000Z"),
      });

      const caseId = generateUuidV7();
      await tx.insert(flagCaseTable).values({
        id: caseId,
        targetActorId: account.actor.id,
        status: "resolved",
        resolved: new Date("2026-06-29T12:00:00.000Z"),
      });
      const [action] = await tx.insert(flagActionTable).values({
        id: generateUuidV7(),
        caseId,
        moderatorId: moderator.account.id,
        actionType: "warning",
        violatedProvisions: ["2.3"],
        rationale: "Digest test",
        created: new Date("2026-06-29T12:01:00.000Z"),
      }).returning();
      await createActionTakenNotification(tx, account.account.id, action);

      await tx.insert(organizationMembershipTable).values([
        {
          organizationAccountId: organization.account.id,
          memberAccountId: account.account.id,
          accepted: new Date("2026-06-29T12:00:00.000Z"),
        },
        {
          organizationAccountId: organization.account.id,
          memberAccountId: otherMember.account.id,
          accepted: new Date("2026-06-29T12:00:00.000Z"),
        },
      ]);
      await tx.insert(notificationTable).values([
        {
          id: generateUuidV7(),
          accountId: organization.account.id,
          type: "follow",
          actorIds: [actor.actor.id],
          created: new Date("2026-06-29T12:01:00.000Z"),
        },
        {
          id: generateUuidV7(),
          accountId: organization.account.id,
          type: "follow",
          actorIds: [moderator.actor.id],
          created: new Date("2026-06-29T12:03:00.000Z"),
        },
      ]);
      await tx.insert(organizationNotificationReadTable).values({
        organizationAccountId: organization.account.id,
        memberAccountId: otherMember.account.id,
        read: new Date("2026-06-29T12:02:00.000Z"),
      });

      const email = createTestEmailTransport();
      const result = await sendNotificationDigests({
        db: tx,
        email: email.transport,
        from: "notifications@hackers.pub",
        origin: "https://hackers.pub",
        frequency: "daily",
        now: new Date("2026-06-30T00:05:00.000Z"),
      });

      assert.deepEqual(result, {
        accountsChecked: 3,
        accountsClaimed: 1,
        emailsSent: 1,
        accountsFailed: 0,
      });
      assert.equal(email.messages.length, 1);
      const message = email.messages[0] as Message;
      assert.deepEqual(message.recipients.map((r) => r.address), [
        "digestuser@example.com",
      ]);
      assert.match(message.subject, /3 unread/);
      assert.match(message.content.text ?? "", /Personal: 1/);
      assert.match(message.content.text ?? "", /Moderation: 1/);
      assert.match(message.content.text ?? "", /Organizations: 1/);
      assert.match(message.content.text ?? "", /Digest Org: New follower/);

      const periodStart = getNotificationDigestPeriodStart(
        "daily",
        new Date("2026-06-30T00:05:00.000Z"),
      );
      const deliveries = await tx.select()
        .from(notificationDigestDeliveryTable)
        .where(
          eq(notificationDigestDeliveryTable.accountId, account.account.id),
        );
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].frequency, "daily");
      assert.equal(+deliveries[0].periodStart, +periodStart);
      assert.equal(deliveries[0].notificationsCount, 3);
      assert.ok(deliveries[0].sent != null);

      const second = await sendNotificationDigests({
        db: tx,
        email: email.transport,
        from: "notifications@hackers.pub",
        origin: "https://hackers.pub",
        frequency: "daily",
        now: new Date("2026-06-30T00:10:00.000Z"),
      });
      assert.equal(second.accountsClaimed, 0);
      assert.equal(email.messages.length, 1);
    });
  },
);

test("sendNotificationDigests localizes digest email content", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "digestko",
      name: "알림 요약 사용자",
      email: "digestko@example.com",
    });
    const actor = await insertAccountWithActor(tx, {
      username: "digestkoactor",
      name: "Digest Korean Actor",
      email: "digestkoactor@example.com",
    });
    await tx.update(accountTable).set({
      locales: ["ko-KR"],
    }).where(eq(accountTable.id, account.account.id));
    await tx.insert(notificationTable).values({
      id: generateUuidV7(),
      accountId: account.account.id,
      type: "follow",
      actorIds: [actor.actor.id],
      created: new Date("2026-06-29T12:00:00.000Z"),
    });

    const email = createTestEmailTransport();
    const result = await sendNotificationDigests({
      db: tx,
      email: email.transport,
      from: "notifications@hackers.pub",
      origin: "https://hackers.pub",
      frequency: "daily",
      now: new Date("2026-06-30T00:05:00.000Z"),
    });

    assert.equal(result.accountsClaimed, 1);
    assert.equal(email.messages.length, 1);
    const message = email.messages[0] as Message;
    const text = message.content.text ?? "";
    assert.match(message.subject, /Hackers' Pub 일간 알림 요약/);
    assert.match(text, /읽지 않은 알림: 1개/);
    assert.match(text, /개인: 1개/);
    assert.match(text, /• 새 팔로워 \(/);
    assert.match(text, /알림 요약 설정 변경:/);
  });
});

test("sendNotificationDigests retries failed digest deliveries", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "digestretryfailed",
      name: "Digest Retry Failed",
      email: "digestretryfailed@example.com",
    });
    const actor = await insertAccountWithActor(tx, {
      username: "digestretryactor",
      name: "Digest Retry Actor",
      email: "digestretryactor@example.com",
    });
    await tx.insert(notificationTable).values({
      id: generateUuidV7(),
      accountId: account.account.id,
      type: "follow",
      actorIds: [actor.actor.id],
      created: new Date("2026-06-29T12:00:00.000Z"),
    });

    const failingEmail = {
      send(_message: Message) {
        throw new Error("Temporary mail outage");
      },
    };
    const first = await sendNotificationDigests({
      db: tx,
      email: failingEmail as never,
      from: "notifications@hackers.pub",
      origin: "https://hackers.pub",
      frequency: "daily",
      now: new Date("2026-06-30T00:05:00.000Z"),
    });

    assert.equal(first.accountsClaimed, 1);
    assert.equal(first.accountsFailed, 1);
    const failedDeliveries = await tx.select()
      .from(notificationDigestDeliveryTable)
      .where(eq(notificationDigestDeliveryTable.accountId, account.account.id));
    assert.equal(failedDeliveries.length, 1);
    assert.ok(failedDeliveries[0].failed != null);
    assert.equal(failedDeliveries[0].sent, null);

    const email = createTestEmailTransport();
    const second = await sendNotificationDigests({
      db: tx,
      email: email.transport,
      from: "notifications@hackers.pub",
      origin: "https://hackers.pub",
      frequency: "daily",
      now: new Date("2026-06-30T00:10:00.000Z"),
    });

    assert.equal(second.accountsClaimed, 1);
    assert.equal(second.accountsFailed, 0);
    assert.equal(email.messages.length, 1);
    const sentDeliveries = await tx.select()
      .from(notificationDigestDeliveryTable)
      .where(eq(notificationDigestDeliveryTable.accountId, account.account.id));
    assert.equal(sentDeliveries.length, 1);
    assert.ok(sentDeliveries[0].sent != null);
    assert.equal(sentDeliveries[0].failed, null);
  });
});

test(
  "sendNotificationDigests does not resend to successful recipients after partial failures",
  async () => {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "digestretrypartial",
        name: "Digest Retry Partial",
        email: "digestretrypartial@example.com",
      });
      const actor = await insertAccountWithActor(tx, {
        username: "digestretrypartialactor",
        name: "Digest Retry Partial Actor",
        email: "digestretrypartialactor@example.com",
      });
      const now = new Date("2026-06-30T00:05:00.000Z");
      await tx.insert(accountEmailTable).values({
        email: "digestretrypartial-backup@example.com",
        accountId: account.account.id,
        public: false,
        verified: now,
        created: now,
      });
      await tx.insert(notificationTable).values({
        id: generateUuidV7(),
        accountId: account.account.id,
        type: "follow",
        actorIds: [actor.actor.id],
        created: new Date("2026-06-29T12:00:00.000Z"),
      });

      const attempted: string[] = [];
      const partialEmail = {
        async send(message: Message) {
          const address = message.recipients[0].address;
          attempted.push(address);
          return {
            successful: address === "digestretrypartial@example.com",
            errorMessages: address === "digestretrypartial@example.com"
              ? []
              : ["Temporary recipient failure"],
          };
        },
      };
      const first = await sendNotificationDigests({
        db: tx,
        email: partialEmail as never,
        from: "notifications@hackers.pub",
        origin: "https://hackers.pub",
        frequency: "daily",
        now,
      });

      assert.equal(first.accountsClaimed, 1);
      assert.equal(first.accountsFailed, 1);
      assert.equal(first.emailsSent, 1);
      assert.deepEqual(attempted, [
        "digestretrypartial@example.com",
        "digestretrypartial-backup@example.com",
      ]);
      const failedDeliveries = await tx.select()
        .from(notificationDigestDeliveryTable)
        .where(
          eq(notificationDigestDeliveryTable.accountId, account.account.id),
        );
      assert.deepEqual(failedDeliveries[0].sentRecipients, [
        "digestretrypartial@example.com",
      ]);

      attempted.length = 0;
      const retryEmail = {
        async send(message: Message) {
          const address = message.recipients[0].address;
          attempted.push(address);
          return { successful: true, errorMessages: [] };
        },
      };
      const second = await sendNotificationDigests({
        db: tx,
        email: retryEmail as never,
        from: "notifications@hackers.pub",
        origin: "https://hackers.pub",
        frequency: "daily",
        now: new Date("2026-06-30T00:10:00.000Z"),
      });

      assert.equal(second.accountsClaimed, 1);
      assert.equal(second.accountsFailed, 0);
      assert.equal(second.emailsSent, 1);
      assert.deepEqual(attempted, [
        "digestretrypartial-backup@example.com",
      ]);
      const sentDeliveries = await tx.select()
        .from(notificationDigestDeliveryTable)
        .where(
          eq(notificationDigestDeliveryTable.accountId, account.account.id),
        );
      assert.ok(sentDeliveries[0].sent != null);
      assert.equal(sentDeliveries[0].failed, null);
      assert.deepEqual(sentDeliveries[0].sentRecipients.sort(), [
        "digestretrypartial-backup@example.com",
        "digestretrypartial@example.com",
      ]);
    });
  },
);

test("sendNotificationDigests retries stale incomplete digest claims", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "digestretrystale",
      name: "Digest Retry Stale",
      email: "digestretrystale@example.com",
    });
    const actor = await insertAccountWithActor(tx, {
      username: "digestretrystaleactor",
      name: "Digest Retry Stale Actor",
      email: "digestretrystaleactor@example.com",
    });
    await tx.insert(notificationTable).values({
      id: generateUuidV7(),
      accountId: account.account.id,
      type: "follow",
      actorIds: [actor.actor.id],
      created: new Date("2026-06-29T12:00:00.000Z"),
    });

    const now = new Date("2026-06-30T00:20:00.000Z");
    const periodStart = getNotificationDigestPeriodStart("daily", now);
    await tx.insert(notificationDigestDeliveryTable).values({
      accountId: account.account.id,
      frequency: "daily",
      periodStart,
      notificationsCount: 1,
      created: new Date("2026-06-30T00:00:00.000Z"),
    });

    const email = createTestEmailTransport();
    const result = await sendNotificationDigests({
      db: tx,
      email: email.transport,
      from: "notifications@hackers.pub",
      origin: "https://hackers.pub",
      frequency: "daily",
      now,
    });

    assert.equal(result.accountsClaimed, 1);
    assert.equal(result.accountsFailed, 0);
    assert.equal(email.messages.length, 1);
    const deliveries = await tx.select()
      .from(notificationDigestDeliveryTable)
      .where(eq(notificationDigestDeliveryTable.accountId, account.account.id));
    assert.equal(deliveries.length, 1);
    assert.ok(deliveries[0].sent != null);
    assert.equal(deliveries[0].failed, null);
  });
});

test(
  "weekly digest suppresses daily digest for weekly-enabled accounts on Mondays",
  async () => {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "digestweekly",
        name: "Digest Weekly",
        email: "digestweekly@example.com",
      });
      const actor = await insertAccountWithActor(tx, {
        username: "digestweeklyactor",
        name: "Digest Weekly Actor",
        email: "digestweeklyactor@example.com",
      });
      await tx.update(accountTable).set({
        notificationEmailDigestDaily: true,
        notificationEmailDigestWeekly: true,
      }).where(eq(accountTable.id, account.account.id));
      await tx.insert(notificationTable).values({
        id: generateUuidV7(),
        accountId: account.account.id,
        type: "follow",
        actorIds: [actor.actor.id],
      });

      const email = createTestEmailTransport();
      const daily = await sendNotificationDigests({
        db: tx,
        email: email.transport,
        from: "notifications@hackers.pub",
        origin: "https://hackers.pub",
        frequency: "daily",
        now: new Date("2026-06-29T00:05:00.000Z"),
      });
      assert.equal(daily.accountsClaimed, 0);
      assert.equal(email.messages.length, 0);

      const weekly = await sendNotificationDigests({
        db: tx,
        email: email.transport,
        from: "notifications@hackers.pub",
        origin: "https://hackers.pub",
        frequency: "weekly",
        now: new Date("2026-06-29T00:00:00.000Z"),
      });
      assert.equal(weekly.accountsClaimed, 1);
      assert.equal(email.messages.length, 1);
    });
  },
);

test("updateNotificationEmailDigestSettings stores private settings", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "digestsettings",
      name: "Digest Settings",
      email: "digestsettings@example.com",
    });

    const result = await execute({
      schema,
      document: updateDigestSettingsMutation,
      variableValues: {
        id: encodeGlobalID("Account", account.account.id),
        daily: false,
        weekly: true,
      },
      contextValue: makeUserContext(tx, account.account),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      updateNotificationEmailDigestSettings: {
        account: {
          notificationEmailDigestDaily: false,
          notificationEmailDigestWeekly: true,
        },
      },
    });
  });
});
