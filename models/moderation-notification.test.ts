import assert from "node:assert";
import { describe, it } from "node:test";
import type { RequestContext } from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { createFlag } from "@hackerspub/models/flag";
import {
  createAppeal,
  resolveAppeal,
  takeModerationAction,
} from "@hackerspub/models/moderation";
import {
  countUnreadModerationNotifications,
  ensureSuspensionEndingNotification,
  getModerationNotifications,
  markModerationNotificationsRead,
  SUSPENSION_ENDING_WINDOW_MS,
} from "@hackerspub/models/moderation-notification";
import { accountTable, actorTable } from "@hackerspub/models/schema";
import { eq, sql } from "drizzle-orm";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

const HOUR = 60 * 60 * 1000;
const REASON = "This post contains harassment targeting another user.";

function quietFedCtx(tx: Transaction): RequestContext<ContextData> {
  const fedCtx = createFedCtx(tx);
  // deno-lint-ignore no-explicit-any
  (fedCtx as any).sendActivity = () => Promise.resolve();
  return fedCtx;
}

async function makeModerator(tx: Transaction, username = "moderator") {
  await tx.update(accountTable).set({ moderator: false });
  const moderator = await insertAccountWithActor(tx, {
    username,
    name: "Moderator",
    email: `${username}@example.com`,
  });
  await tx.update(accountTable)
    .set({ moderator: true })
    .where(eq(accountTable.id, moderator.account.id));
  const account = await tx.query.accountTable.findFirst({
    where: { id: moderator.account.id },
  });
  assert.ok(account != null);
  return { ...moderator, account: { ...moderator.account, ...account } };
}

async function suspendedAccountWithAction(
  tx: Transaction,
  fedCtx: RequestContext<ContextData>,
  suspensionEnds: Date,
) {
  const moderator = await makeModerator(tx);
  const reporter = await insertAccountWithActor(tx, {
    username: "reporter",
    name: "Reporter",
    email: "reporter@example.com",
  });
  const reported = await insertAccountWithActor(tx, {
    username: "reported",
    name: "Reported",
    email: "reported@example.com",
  });
  const { post } = await insertNotePost(tx, { account: reported.account });
  const flag = await createFlag(tx, {
    reporter: reporter.actor,
    targetActor: reported.actor,
    targetPost: post,
    reason: REASON,
  });
  assert.ok(flag != null);
  const action = await takeModerationAction(fedCtx, {
    caseId: flag.caseId,
    moderator: moderator.account,
    actionType: "suspend",
    violatedProvisions: ["2.3"],
    rationale: "Suspension.",
    suspensionStarts: new Date(Date.now() - HOUR),
    suspensionEnds,
  });
  assert.ok(action != null);
  const account = await tx.query.accountTable.findFirst({
    where: { id: reported.account.id },
    with: { actor: true },
  });
  assert.ok(account != null);
  return { account, action, moderator };
}

describe("getModerationNotifications()", () => {
  it("lists the account's notifications, newest first", async () => {
    await withRollback(async (tx) => {
      const fedCtx = quietFedCtx(tx);
      const { account, action } = await suspendedAccountWithAction(
        tx,
        fedCtx,
        new Date(Date.now() + 30 * 24 * HOUR),
      );
      const notifications = await getModerationNotifications(
        tx,
        account.id,
      );
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].type, "action_taken");
      assert.equal(notifications[0].actionId, action.id);
      assert.equal(notifications[0].action?.id, action.id);
    });
  });
});

describe("markModerationNotificationsRead()", () => {
  it("marks unread notifications read and counts them", async () => {
    await withRollback(async (tx) => {
      const fedCtx = quietFedCtx(tx);
      const { account } = await suspendedAccountWithAction(
        tx,
        fedCtx,
        new Date(Date.now() + 30 * 24 * HOUR),
      );
      assert.equal(
        await countUnreadModerationNotifications(tx, account.id),
        1,
      );
      const marked = await markModerationNotificationsRead(tx, account.id);
      assert.equal(marked, 1);
      assert.equal(
        await countUnreadModerationNotifications(tx, account.id),
        0,
      );
      // Idempotent:
      assert.equal(
        await markModerationNotificationsRead(tx, account.id),
        0,
      );
    });
  });

  it("covers the boundary row despite microsecond timestamps", async () => {
    await withRollback(async (tx) => {
      const fedCtx = quietFedCtx(tx);
      const { account } = await suspendedAccountWithAction(
        tx,
        fedCtx,
        new Date(Date.now() + 30 * 24 * HOUR),
      );
      const [notification] = await getModerationNotifications(
        tx,
        account.id,
      );
      assert.ok(notification != null);
      // Stored timestamps carry microseconds a JS Date cannot represent:
      await tx.execute(sql`
        update moderation_notification
        set created = '2026-04-15T00:00:00.123456Z'::timestamptz
        where id = ${notification.id}
      `);
      const marked = await markModerationNotificationsRead(
        tx,
        account.id,
        notification.id,
      );
      assert.equal(marked, 1);
      assert.equal(
        await countUnreadModerationNotifications(tx, account.id),
        0,
      );
      // An id that is not the account's marks nothing.
      const other = await insertAccountWithActor(tx, {
        username: "othermod",
        name: "Other",
        email: "othermod@example.com",
      });
      assert.equal(
        await markModerationNotificationsRead(
          tx,
          other.account.id,
          notification.id,
        ),
        0,
      );
    });
  });
});

describe("ensureSuspensionEndingNotification()", () => {
  it("creates the notification once when the end approaches", async () => {
    await withRollback(async (tx) => {
      const fedCtx = quietFedCtx(tx);
      const ends = new Date(
        Date.now() + SUSPENSION_ENDING_WINDOW_MS - HOUR,
      );
      const { account, action } = await suspendedAccountWithAction(
        tx,
        fedCtx,
        ends,
      );
      const created = await ensureSuspensionEndingNotification(tx, account);
      assert.ok(created != null);
      assert.equal(created.type, "suspension_ending");
      assert.equal(created.actionId, action.id);
      assert.equal(created.accountId, account.id);
      // Lazy creation deduplicates via the partial unique index:
      const again = await ensureSuspensionEndingNotification(tx, account);
      assert.equal(again, undefined);
    });
  });

  it("does nothing when the end is far away or already passed", async () => {
    await withRollback(async (tx) => {
      const fedCtx = quietFedCtx(tx);
      const { account } = await suspendedAccountWithAction(
        tx,
        fedCtx,
        new Date(Date.now() + SUSPENSION_ENDING_WINDOW_MS + 24 * HOUR),
      );
      assert.equal(
        await ensureSuspensionEndingNotification(tx, account),
        undefined,
      );
      // Simulate an already-expired suspension:
      await tx.update(actorTable)
        .set({
          suspended: new Date(Date.now() - 2 * HOUR),
          suspendedUntil: new Date(Date.now() - HOUR),
        })
        .where(eq(actorTable.id, account.actor.id));
      const refreshed = await tx.query.accountTable.findFirst({
        where: { id: account.id },
        with: { actor: true },
      });
      assert.ok(refreshed != null);
      assert.equal(
        await ensureSuspensionEndingNotification(tx, refreshed),
        undefined,
      );
    });
  });

  it("references the suspension that actually ends, not the newest", async () => {
    await withRollback(async (tx) => {
      const fedCtx = quietFedCtx(tx);
      const endsLong = new Date(
        Date.now() + SUSPENSION_ENDING_WINDOW_MS - HOUR,
      );
      const { account, action: longAction, moderator } =
        await suspendedAccountWithAction(tx, fedCtx, endsLong);
      // A second, shorter suspension filed later on a new case.  The
      // effective suspendedUntil stays at the longer end, so the
      // notification must reference the longer (older) action even though
      // the shorter one was created more recently.
      const reporter2 = await insertAccountWithActor(tx, {
        username: "reporter2",
        name: "Reporter 2",
        email: "reporter2@example.com",
      });
      const flag2 = await createFlag(tx, {
        reporter: reporter2.actor,
        targetActor: account.actor,
        reason: REASON,
      });
      assert.ok(flag2 != null);
      const shortAction = await takeModerationAction(fedCtx, {
        caseId: flag2.caseId,
        moderator: moderator.account,
        actionType: "suspend",
        violatedProvisions: ["2.3"],
        rationale: "Second, shorter suspension.",
        suspensionStarts: new Date(Date.now() - HOUR),
        suspensionEnds: new Date(Date.now() + HOUR),
      });
      assert.ok(shortAction != null);
      const refreshed = await tx.query.accountTable.findFirst({
        where: { id: account.id },
        with: { actor: true },
      });
      assert.ok(refreshed != null);
      assert.equal(
        refreshed.actor.suspendedUntil?.getTime(),
        endsLong.getTime(),
      );
      const created = await ensureSuspensionEndingNotification(tx, refreshed);
      assert.ok(created != null);
      assert.equal(created.actionId, longAction.id);
    });
  });

  it("skips suspensions overturned by a resolved appeal", async () => {
    await withRollback(async (tx) => {
      const fedCtx = quietFedCtx(tx);
      const ends = new Date(Date.now() + SUSPENSION_ENDING_WINDOW_MS - HOUR);
      const { account, action: standingAction, moderator } =
        await suspendedAccountWithAction(tx, fedCtx, ends);
      // A second suspension with the *same* end, filed later, then
      // overturned on appeal: the notification must reference the older
      // action that still stands, not the newest one.
      const reporter2 = await insertAccountWithActor(tx, {
        username: "reporter2",
        name: "Reporter 2",
        email: "reporter2@example.com",
      });
      const flag2 = await createFlag(tx, {
        reporter: reporter2.actor,
        targetActor: account.actor,
        reason: REASON,
      });
      assert.ok(flag2 != null);
      const overturnedAction = await takeModerationAction(fedCtx, {
        caseId: flag2.caseId,
        moderator: moderator.account,
        actionType: "suspend",
        violatedProvisions: ["2.3"],
        rationale: "Second suspension, later overturned.",
        suspensionStarts: new Date(Date.now() - HOUR),
        suspensionEnds: ends,
      });
      assert.ok(overturnedAction != null);
      const appeal = await createAppeal(tx, {
        actionId: overturnedAction.id,
        appellant: account,
        reason: "This duplicate sanction is unjust.",
      });
      assert.ok(appeal != null);
      const resolved = await resolveAppeal(tx, {
        appealId: appeal.id,
        reviewer: moderator.account,
        result: "withdrawn",
        reviewRationale: "Duplicate of an existing sanction.",
      });
      assert.ok(resolved != null);
      const refreshed = await tx.query.accountTable.findFirst({
        where: { id: account.id },
        with: { actor: true },
      });
      assert.ok(refreshed != null);
      assert.equal(
        refreshed.actor.suspendedUntil?.getTime(),
        ends.getTime(),
      );
      const created = await ensureSuspensionEndingNotification(tx, refreshed);
      assert.ok(created != null);
      assert.equal(created.actionId, standingAction.id);
    });
  });

  it("does nothing for unsuspended accounts", async () => {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "ordinary",
        name: "Ordinary",
        email: "ordinary@example.com",
      });
      const loaded = await tx.query.accountTable.findFirst({
        where: { id: account.account.id },
        with: { actor: true },
      });
      assert.ok(loaded != null);
      assert.equal(
        await ensureSuspensionEndingNotification(tx, loaded),
        undefined,
      );
    });
  });
});
