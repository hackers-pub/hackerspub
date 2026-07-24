import assert from "node:assert";
import { describe, it } from "node:test";
import type { Transaction } from "@hackerspub/models/db";
import { createFlag } from "@hackerspub/models/flag";
import {
  APPEAL_WINDOW_MS,
  createAppeal,
  getViolationHistory,
  resolveAppeal,
  takeModerationAction,
} from "@hackerspub/models/moderation";
import {
  accountTable,
  flagActionTable,
  type FlagActionType,
} from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

const HOUR = 60 * 60 * 1000;
const REASON = "This post contains harassment targeting another user.";

function recordingFedCtx(tx: Transaction): ReturnType<typeof createFedCtx> {
  const fedCtx = createFedCtx(tx);
  // deno-lint-ignore no-explicit-any
  (fedCtx as any).sendActivity = () => Promise.resolve();
  return fedCtx;
}

async function makeModerator(tx: Transaction, username = "moderator") {
  // Isolate from any moderator accounts already present in the database;
  // the update is rolled back with the transaction.
  await tx.update(accountTable).set({ moderator: false });
  const moderator = await insertAccountWithActor(tx, {
    username,
    name: "Moderator",
    email: `${username}@example.com`,
  });
  await tx
    .update(accountTable)
    .set({ moderator: true })
    .where(eq(accountTable.id, moderator.account.id));
  const account = await tx.query.accountTable.findFirst({
    where: { id: moderator.account.id },
  });
  assert.ok(account != null);
  return { ...moderator, account: { ...moderator.account, ...account } };
}

async function makeSanctionedCase(
  tx: Transaction,
  fedCtx: ReturnType<typeof createFedCtx>,
  actionType: FlagActionType,
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
    actionType,
    violatedProvisions: actionType === "dismiss" ? undefined : ["2.3"],
    rationale: "Action rationale.",
    messageToUser: "You were sanctioned.",
    ...(actionType === "suspend"
      ? {
          suspensionStarts: new Date(Date.now() - HOUR),
          suspensionEnds: new Date(Date.now() + 30 * 24 * HOUR),
        }
      : {}),
  });
  assert.ok(action != null);
  return { moderator, reported, post, action, flag };
}

describe("createAppeal()", () => {
  it("files an appeal and notifies moderators", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { moderator, reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "warning",
      );
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "I believe this decision misread the context.",
        additionalContext: "The conversation was satirical.",
      });
      assert.ok(appeal != null);
      assert.equal(appeal.actionId, action.id);
      assert.equal(appeal.appellantId, reported.account.id);
      assert.equal(appeal.status, "pending");
      assert.equal(appeal.result, null);
      const notifications = await tx.query.moderationNotificationTable.findMany(
        {
          where: { type: "appeal_received", appealId: appeal.id },
        },
      );
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].accountId, moderator.account.id);
      assert.equal(notifications[0].appealId, appeal.id);
    });
  });

  it("excludes a moderator-appellant from the notification fan-out", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { moderator, reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "warning",
      );
      // The sanctioned user is themselves a moderator: they cannot review
      // their own appeal (the queue and resolver exclude it), so they must
      // not be notified about a case they cannot open.
      await tx
        .update(accountTable)
        .set({ moderator: true })
        .where(eq(accountTable.id, reported.account.id));
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "I believe this decision misread the context.",
      });
      assert.ok(appeal != null);
      const notifications = await tx.query.moderationNotificationTable.findMany(
        {
          where: { type: "appeal_received", appealId: appeal.id },
        },
      );
      // Only the other moderator (who took the action) is notified.
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].accountId, moderator.account.id);
      assert.notEqual(notifications[0].accountId, reported.account.id);
    });
  });

  it("rejects appeals outside the 14-day window", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "warning",
      );
      await tx
        .update(flagActionTable)
        .set({ created: new Date(Date.now() - APPEAL_WINDOW_MS - HOUR) })
        .where(eq(flagActionTable.id, action.id));
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "Too late, sadly.",
      });
      assert.equal(appeal, undefined);
    });
  });

  it("allows only one appeal per action", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "warning",
      );
      const first = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "First appeal.",
      });
      assert.ok(first != null);
      const second = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "Second appeal.",
      });
      assert.equal(second, undefined);
    });
  });

  it("rejects appeals from anyone but the sanctioned user", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { action } = await makeSanctionedCase(tx, fedCtx, "warning");
      const bystander = await insertAccountWithActor(tx, {
        username: "bystander",
        name: "Bystander",
        email: "bystander@example.com",
      });
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: bystander.account,
        reason: "I object on someone else's behalf.",
      });
      assert.equal(appeal, undefined);
    });
  });

  it("rejects appeals against dismissals", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "dismiss",
      );
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "Appealing a dismissal makes no sense.",
      });
      assert.equal(appeal, undefined);
    });
  });
});

describe("resolveAppeal()", () => {
  it("dismissing the appeal keeps the sanction", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { moderator, reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "ban",
      );
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "Please reconsider.",
      });
      assert.ok(appeal != null);
      const resolved = await resolveAppeal(tx, {
        appealId: appeal.id,
        reviewer: moderator.account,
        result: "dismissed",
        reviewRationale: "The original decision stands.",
      });
      assert.ok(resolved != null);
      assert.equal(resolved.status, "resolved");
      assert.equal(resolved.result, "dismissed");
      assert.equal(resolved.reviewerId, moderator.account.id);
      const actor = await tx.query.actorTable.findFirst({
        where: { id: reported.actor.id },
      });
      assert.ok(actor?.suspended != null);
      const notifications = await tx.query.moderationNotificationTable.findMany(
        {
          where: { type: "appeal_resolved", appealId: appeal.id },
        },
      );
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].accountId, reported.account.id);
    });
  });

  it("withdrawing reverts censorship", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { moderator, reported, post, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "censor",
      );
      const censoredPost = await tx.query.postTable.findFirst({
        where: { id: post.id },
      });
      assert.ok(censoredPost?.censored != null);
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "The post did not violate anything.",
      });
      assert.ok(appeal != null);
      const resolved = await resolveAppeal(tx, {
        appealId: appeal.id,
        reviewer: moderator.account,
        result: "withdrawn",
        reviewRationale: "On review, no violation.",
      });
      assert.ok(resolved != null);
      const restoredPost = await tx.query.postTable.findFirst({
        where: { id: post.id },
      });
      assert.equal(restoredPost?.censored, null);
    });
  });

  it("withdrawing reverts a suspension", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { moderator, reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "suspend",
      );
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "Disproportionate.",
      });
      assert.ok(appeal != null);
      await resolveAppeal(tx, {
        appealId: appeal.id,
        reviewer: moderator.account,
        result: "withdrawn",
        reviewRationale: "Action withdrawn.",
      });
      const actor = await tx.query.actorTable.findFirst({
        where: { id: reported.actor.id },
      });
      assert.equal(actor?.suspended, null);
      assert.equal(actor?.suspendedUntil, null);
    });
  });

  it("withdrawing one sanction keeps another that still stands", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      // Case A: a suspension on the reported actor.
      const {
        moderator,
        reported,
        action: suspendAction,
      } = await makeSanctionedCase(tx, fedCtx, "suspend");
      // Case B: a separate ban on the same actor (a user report).
      const reporterB = await insertAccountWithActor(tx, {
        username: "reporterb",
        name: "Reporter B",
        email: "reporterb@example.com",
      });
      const flagB = await createFlag(tx, {
        reporter: reporterB.actor,
        targetActor: reported.actor,
        reason: REASON,
      });
      assert.ok(flagB != null);
      const banAction = await takeModerationAction(fedCtx, {
        caseId: flagB.caseId,
        moderator: moderator.account,
        actionType: "ban",
        violatedProvisions: ["2.3"],
        rationale: "Severe and persistent.",
      });
      assert.ok(banAction != null);
      const banned = await tx.query.actorTable.findFirst({
        where: { id: reported.actor.id },
      });
      assert.ok(banned?.suspended != null);
      assert.equal(banned?.suspendedUntil, null);

      // Withdraw the suspension (case A); the ban (case B) still stands.
      const appeal = await createAppeal(tx, {
        actionId: suspendAction.id,
        appellant: reported.account,
        reason: "The suspension was unfair.",
      });
      assert.ok(appeal != null);
      await resolveAppeal(tx, {
        appealId: appeal.id,
        reviewer: moderator.account,
        result: "withdrawn",
        reviewRationale: "Suspension withdrawn.",
      });
      const stillBanned = await tx.query.actorTable.findFirst({
        where: { id: reported.actor.id },
      });
      assert.ok(stillBanned?.suspended != null);
      assert.equal(stillBanned?.suspendedUntil, null);
    });
  });

  it("reducing replaces the sanction with a lighter action", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { moderator, reported, action, flag } = await makeSanctionedCase(
        tx,
        fedCtx,
        "ban",
      );
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "A permanent ban is too harsh.",
      });
      assert.ok(appeal != null);
      const starts = new Date(Date.now() - HOUR);
      const ends = new Date(Date.now() + 7 * 24 * HOUR);
      const resolved = await resolveAppeal(tx, {
        appealId: appeal.id,
        reviewer: moderator.account,
        result: "reduced",
        reviewRationale: "Reduced to a 7-day suspension.",
        replacement: {
          actionType: "suspend",
          violatedProvisions: ["2.3"],
          rationale: "Reduced on appeal.",
          messageToUser: "Your ban was reduced to a 7-day suspension.",
          suspensionStarts: starts,
          suspensionEnds: ends,
        },
      });
      assert.ok(resolved != null);
      const actor = await tx.query.actorTable.findFirst({
        where: { id: reported.actor.id },
      });
      assert.deepEqual(actor?.suspended, starts);
      assert.deepEqual(actor?.suspendedUntil, ends);
      // The replacement is a new immutable action row on the same case:
      const actions = await tx.query.flagActionTable.findMany({
        where: { caseId: flag.caseId },
        orderBy: { created: "asc" },
      });
      assert.equal(actions.length, 2);
      assert.equal(actions[0].actionType, "ban");
      assert.equal(actions[1].actionType, "suspend");
    });
  });

  it("removes withdrawn actions from the violation history", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { moderator, reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "warning",
      );
      assert.equal(
        (await getViolationHistory(tx, reported.actor.id)).length,
        1,
      );
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "Unjust.",
      });
      assert.ok(appeal != null);
      // An open appeal keeps the action in the history:
      assert.equal(
        (await getViolationHistory(tx, reported.actor.id)).length,
        1,
      );
      await resolveAppeal(tx, {
        appealId: appeal.id,
        reviewer: moderator.account,
        result: "withdrawn",
        reviewRationale: "Withdrawn on review.",
      });
      assert.equal(
        (await getViolationHistory(tx, reported.actor.id)).length,
        0,
      );
    });
  });

  it("requires a replacement for reduced/increased results", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { moderator, reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "ban",
      );
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "Too harsh.",
      });
      assert.ok(appeal != null);
      assert.equal(
        await resolveAppeal(tx, {
          appealId: appeal.id,
          reviewer: moderator.account,
          result: "reduced",
          reviewRationale: "Missing replacement.",
        }),
        undefined,
      );
    });
  });

  it("rejects non-moderator reviewers and double resolution", async () => {
    await withRollback(async (tx) => {
      const fedCtx = recordingFedCtx(tx);
      const { moderator, reported, action } = await makeSanctionedCase(
        tx,
        fedCtx,
        "warning",
      );
      const appeal = await createAppeal(tx, {
        actionId: action.id,
        appellant: reported.account,
        reason: "Objection.",
      });
      assert.ok(appeal != null);
      assert.equal(
        await resolveAppeal(tx, {
          appealId: appeal.id,
          reviewer: reported.account,
          result: "dismissed",
          reviewRationale: "Not a moderator.",
        }),
        undefined,
      );
      const resolved = await resolveAppeal(tx, {
        appealId: appeal.id,
        reviewer: moderator.account,
        result: "dismissed",
        reviewRationale: "Stands.",
      });
      assert.ok(resolved != null);
      assert.equal(
        await resolveAppeal(tx, {
          appealId: appeal.id,
          reviewer: moderator.account,
          result: "dismissed",
          reviewRationale: "Again.",
        }),
        undefined,
      );
    });
  });
});
