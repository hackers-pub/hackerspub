import assert from "node:assert";
import { describe, it } from "node:test";
import type { RequestContext } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import { createFlag } from "@hackerspub/models/flag";
import {
  assignCase,
  enqueueExpiredSuspensionRescores,
  getViolationHistory,
  listSanctionedActors,
  sweepExpiredSuspensionRescores,
  takeModerationAction,
  updateCaseStatus,
} from "@hackerspub/models/moderation";
import {
  accountTable,
  type Actor,
  actorTable,
  adminStateTable,
  flagActionTable,
  type Post,
} from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertPostLink,
  insertRemoteActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

const HOUR = 60 * 60 * 1000;
const REASON = "This post contains harassment targeting another user.";

interface SentActivity {
  sender: unknown;
  activity: unknown;
}

function recordingFedCtx(
  tx: Transaction,
): { fedCtx: RequestContext<ContextData>; sent: SentActivity[] } {
  const fedCtx = createFedCtx(tx);
  const sent: SentActivity[] = [];
  // deno-lint-ignore no-explicit-any
  (fedCtx as any).sendActivity = (
    sender: unknown,
    _recipients: unknown,
    activity: unknown,
  ) => {
    sent.push({ sender, activity });
    return Promise.resolve();
  };
  return { fedCtx, sent };
}

async function makeModerator(tx: Transaction, username = "moderator") {
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

async function makeReportedPostCase(
  tx: Transaction,
  options: { forwardToRemote?: boolean; remote?: boolean } = {},
): Promise<{
  flag: NonNullable<Awaited<ReturnType<typeof createFlag>>>;
  post: Post;
  targetActor: Actor;
}> {
  const reporter = await insertAccountWithActor(tx, {
    username: "reporter",
    name: "Reporter",
    email: "reporter@example.com",
  });
  let targetActor: Actor;
  let post: Post;
  if (options.remote) {
    targetActor = await insertRemoteActor(tx, {
      username: "troll",
      name: "Troll",
      host: "remote.example",
    });
    post = await insertRemotePost(tx, { actorId: targetActor.id });
  } else {
    const reported = await insertAccountWithActor(tx, {
      username: "reported",
      name: "Reported",
      email: "reported@example.com",
    });
    targetActor = reported.actor;
    post = (await insertNotePost(tx, { account: reported.account })).post;
  }
  const flag = await createFlag(tx, {
    reporter: reporter.actor,
    targetActor,
    targetPost: post,
    reason: REASON,
    forwardToRemote: options.forwardToRemote,
  });
  assert.ok(flag != null);
  return { flag, post, targetActor };
}

describe("takeModerationAction()", () => {
  it("dismisses a case without enforcement", async () => {
    await withRollback(async (tx) => {
      const { fedCtx, sent } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag, post, targetActor } = await makeReportedPostCase(tx);
      const action = await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "dismiss",
        rationale: "Not a violation of the code of conduct.",
      });
      assert.ok(action != null);
      assert.equal(action.actionType, "dismiss");
      assert.deepEqual(action.violatedProvisions, []);
      const flagCase = await tx.query.flagCaseTable.findFirst({
        where: { id: flag.caseId },
      });
      assert.equal(flagCase?.status, "dismissed");
      assert.ok(flagCase?.resolved != null);
      const updatedFlag = await tx.query.flagTable.findFirst({
        where: { id: flag.id },
      });
      assert.equal(updatedFlag?.status, "dismissed");
      const updatedPost = await tx.query.postTable.findFirst({
        where: { id: post.id },
      });
      assert.equal(updatedPost?.censored, null);
      const updatedActor = await tx.query.actorTable.findFirst({
        where: { id: targetActor.id },
      });
      assert.equal(updatedActor?.suspended, null);
      // A dismissal without a message does not notify the reported user.
      const notifications = await tx.query.moderationNotificationTable
        .findMany({ where: { type: "action_taken" } });
      assert.equal(notifications.length, 0);
      assert.equal(sent.length, 0);
    });
  });

  it("records a warning and notifies the reported user", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag, targetActor } = await makeReportedPostCase(tx);
      const action = await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "warning",
        violatedProvisions: ["2.3"],
        rationale: "First offense; education preferred.",
        messageToUser: "Please review our code of conduct on harassment.",
      });
      assert.ok(action != null);
      const flagCase = await tx.query.flagCaseTable.findFirst({
        where: { id: flag.caseId },
      });
      assert.equal(flagCase?.status, "resolved");
      const updatedActor = await tx.query.actorTable.findFirst({
        where: { id: targetActor.id },
      });
      assert.equal(updatedActor?.suspended, null);
      const notifications = await tx.query.moderationNotificationTable
        .findMany({ where: { type: "action_taken" } });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].actionId, action.id);
      const targetAccount = await tx.query.actorTable.findFirst({
        where: { id: targetActor.id },
        columns: { accountId: true },
      });
      assert.equal(notifications[0].accountId, targetAccount?.accountId);
    });
  });

  it("censors the reported post and enqueues a news rescore", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
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
      const link = await insertPostLink(tx, {
        url: "https://example.com/spam",
      });
      const { post } = await insertNotePost(tx, {
        account: reported.account,
        link: { id: link.id, url: link.url },
      });
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
        actionType: "censor",
        violatedProvisions: ["3.2"],
        rationale: "The content itself violates the code of conduct.",
        messageToUser: "Your post was hidden.",
      });
      assert.ok(action != null);
      const updatedPost = await tx.query.postTable.findFirst({
        where: { id: post.id },
      });
      assert.ok(updatedPost?.censored != null);
      const queued = await tx.query.newsRescoreQueueTable.findFirst({
        where: { actorId: reported.actor.id },
      });
      assert.ok(queued != null);
    });
  });

  it("suspends the target actor for the given window", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag, targetActor } = await makeReportedPostCase(tx);
      const starts = new Date(Date.now() - HOUR);
      const ends = new Date(Date.now() + 7 * 24 * HOUR);
      const action = await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "suspend",
        violatedProvisions: ["2.3", "3.1"],
        rationale: "Repeated violations.",
        messageToUser: "Your account is suspended for 7 days.",
        suspensionStarts: starts,
        suspensionEnds: ends,
      });
      assert.ok(action != null);
      assert.deepEqual(action.suspensionStarts, starts);
      assert.deepEqual(action.suspensionEnds, ends);
      const updatedActor = await tx.query.actorTable.findFirst({
        where: { id: targetActor.id },
      });
      assert.deepEqual(updatedActor?.suspended, starts);
      assert.deepEqual(updatedActor?.suspendedUntil, ends);
    });
  });

  it("bans the target actor permanently", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag, targetActor } = await makeReportedPostCase(tx);
      const action = await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "ban",
        violatedProvisions: ["2.3"],
        rationale: "Severe and persistent malicious behavior.",
      });
      assert.ok(action != null);
      const updatedActor = await tx.query.actorTable.findFirst({
        where: { id: targetActor.id },
      });
      assert.ok(updatedActor?.suspended != null);
      assert.equal(updatedActor?.suspendedUntil, null);
      // Banning hides the actor's content, so their news links rescore.
      const queued = await tx.query.newsRescoreQueueTable.findFirst({
        where: { actorId: targetActor.id },
      });
      assert.ok(queued != null);
    });
  });

  it("rejects invalid inputs", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const nonModerator = await insertAccountWithActor(tx, {
        username: "ordinary",
        name: "Ordinary",
        email: "ordinary@example.com",
      });
      const { flag } = await makeReportedPostCase(tx);
      // Non-moderator:
      assert.equal(
        await takeModerationAction(fedCtx, {
          caseId: flag.caseId,
          moderator: nonModerator.account,
          actionType: "warning",
          violatedProvisions: ["2.3"],
          rationale: "Nope.",
        }),
        undefined,
      );
      // Missing provisions on a non-dismiss action:
      assert.equal(
        await takeModerationAction(fedCtx, {
          caseId: flag.caseId,
          moderator: moderator.account,
          actionType: "warning",
          rationale: "No provisions given.",
        }),
        undefined,
      );
      // Suspension without a window, and with an inverted window:
      assert.equal(
        await takeModerationAction(fedCtx, {
          caseId: flag.caseId,
          moderator: moderator.account,
          actionType: "suspend",
          violatedProvisions: ["2.3"],
          rationale: "No window.",
        }),
        undefined,
      );
      assert.equal(
        await takeModerationAction(fedCtx, {
          caseId: flag.caseId,
          moderator: moderator.account,
          actionType: "suspend",
          violatedProvisions: ["2.3"],
          rationale: "Inverted window.",
          suspensionStarts: new Date(Date.now() + HOUR),
          suspensionEnds: new Date(Date.now() - HOUR),
        }),
        undefined,
      );
      // Already-expired windows are rejected:
      assert.equal(
        await takeModerationAction(fedCtx, {
          caseId: flag.caseId,
          moderator: moderator.account,
          actionType: "suspend",
          violatedProvisions: ["2.3"],
          rationale: "Expired window.",
          suspensionStarts: new Date(Date.now() - 2 * HOUR),
          suspensionEnds: new Date(Date.now() - HOUR),
        }),
        undefined,
      );
      // Scheduled future suspensions are not supported:
      assert.equal(
        await takeModerationAction(fedCtx, {
          caseId: flag.caseId,
          moderator: moderator.account,
          actionType: "suspend",
          violatedProvisions: ["2.3"],
          rationale: "Future start.",
          suspensionStarts: new Date(Date.now() + HOUR),
          suspensionEnds: new Date(Date.now() + 2 * HOUR),
        }),
        undefined,
      );
    });
  });

  it("rejects censoring a user report without a post", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
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
      const flag = await createFlag(tx, {
        reporter: reporter.actor,
        targetActor: reported.actor,
        reason: REASON,
      });
      assert.ok(flag != null);
      assert.equal(
        await takeModerationAction(fedCtx, {
          caseId: flag.caseId,
          moderator: moderator.account,
          actionType: "censor",
          violatedProvisions: ["2.3"],
          rationale: "There is no post to censor.",
        }),
        undefined,
      );
    });
  });

  it("rejects acting on an already-resolved case", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag } = await makeReportedPostCase(tx);
      const first = await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "dismiss",
        rationale: "Nothing here.",
      });
      assert.ok(first != null);
      const second = await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "warning",
        violatedProvisions: ["2.3"],
        rationale: "Too late.",
      });
      assert.equal(second, undefined);
    });
  });

  it("forwards a Flag from the instance actor when opted in", async () => {
    await withRollback(async (tx) => {
      const { fedCtx, sent } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag, post, targetActor } = await makeReportedPostCase(tx, {
        remote: true,
        forwardToRemote: true,
      });
      const action = await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "ban",
        violatedProvisions: ["2.3"],
        rationale: "Internal rationale with details only moderators see.",
        forwardSummary: "Violation of our code of conduct: harassment.",
      });
      assert.ok(action != null);
      assert.equal(sent.length, 1);
      const { sender, activity } = sent[0];
      // Sent from the instance actor, never a personal actor:
      assert.deepEqual(sender, { identifier: "localhost" });
      assert.ok(activity instanceof vocab.Flag);
      const content = activity.content?.toString() ?? "";
      assert.match(content, /harassment/);
      // The reporter's original wording must never leak:
      assert.ok(!content.includes(REASON));
      const objectIds = activity.objectIds.map((u) => u.href);
      assert.ok(objectIds.includes(targetActor.iri));
      assert.ok(objectIds.includes(post.iri));
    });
  });

  it("does not forward without reporter opt-in or for local targets", async () => {
    await withRollback(async (tx) => {
      const { fedCtx, sent } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      // Remote target, no opt-in:
      const remoteCase = await makeReportedPostCase(tx, { remote: true });
      const remoteAction = await takeModerationAction(fedCtx, {
        caseId: remoteCase.flag.caseId,
        moderator: moderator.account,
        actionType: "ban",
        violatedProvisions: ["2.3"],
        rationale: "No forwarding requested.",
      });
      assert.ok(remoteAction != null);
      assert.equal(sent.length, 0);
    });
  });

  it("does not forward dismissals even when opted in", async () => {
    await withRollback(async (tx) => {
      const { fedCtx, sent } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag } = await makeReportedPostCase(tx, {
        remote: true,
        forwardToRemote: true,
      });
      const action = await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "dismiss",
        rationale: "Not a violation.",
      });
      assert.ok(action != null);
      assert.equal(sent.length, 0);
    });
  });
});

describe("assignCase()", () => {
  it("assigns a moderator and moves the case to reviewing", async () => {
    await withRollback(async (tx) => {
      const moderator = await makeModerator(tx);
      const { flag } = await makeReportedPostCase(tx);
      const updated = await assignCase(
        tx,
        flag.caseId,
        moderator.account.id,
      );
      assert.equal(updated?.assignedModeratorId, moderator.account.id);
      assert.equal(updated?.status, "reviewing");
      const unassigned = await assignCase(tx, flag.caseId, null);
      assert.equal(unassigned?.assignedModeratorId, null);
      assert.equal(unassigned?.status, "reviewing");
    });
  });

  it("rejects assigning a non-moderator", async () => {
    await withRollback(async (tx) => {
      const ordinary = await insertAccountWithActor(tx, {
        username: "ordinary",
        name: "Ordinary",
        email: "ordinary@example.com",
      });
      const { flag } = await makeReportedPostCase(tx);
      assert.equal(
        await assignCase(tx, flag.caseId, ordinary.account.id),
        undefined,
      );
    });
  });
});

describe("updateCaseStatus()", () => {
  it("moves between pending and reviewing only", async () => {
    await withRollback(async (tx) => {
      const moderator = await makeModerator(tx);
      const { fedCtx } = recordingFedCtx(tx);
      const { flag } = await makeReportedPostCase(tx);
      const reviewing = await updateCaseStatus(tx, flag.caseId, "reviewing");
      assert.equal(reviewing?.status, "reviewing");
      const pending = await updateCaseStatus(tx, flag.caseId, "pending");
      assert.equal(pending?.status, "pending");
      await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "dismiss",
        rationale: "Done.",
      });
      assert.equal(
        await updateCaseStatus(tx, flag.caseId, "reviewing"),
        undefined,
      );
    });
  });
});

describe("getViolationHistory()", () => {
  it("lists actions against the target, hiding stale warnings", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag, targetActor } = await makeReportedPostCase(tx);
      const action = await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "warning",
        violatedProvisions: ["2.3"],
        rationale: "Recent warning.",
      });
      assert.ok(action != null);
      const history = await getViolationHistory(tx, targetActor.id);
      assert.equal(history.length, 1);
      assert.equal(history[0].id, action.id);
      // A warning older than a year with no subsequent violation drops out.
      const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * HOUR);
      await tx.update(flagActionTable)
        .set({ created: twoYearsAgo })
        .where(eq(flagActionTable.id, action.id));
      const stale = await getViolationHistory(tx, targetActor.id);
      assert.equal(stale.length, 0);
    });
  });

  it("excludes dismissals", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag, targetActor } = await makeReportedPostCase(tx);
      await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "dismiss",
        rationale: "Not a violation.",
      });
      const history = await getViolationHistory(tx, targetActor.id);
      assert.equal(history.length, 0);
    });
  });
});

describe("enqueueExpiredSuspensionRescores()", () => {
  it("queues remote actors whose suspension recently expired", async () => {
    await withRollback(async (tx) => {
      const expiredRemote = await insertRemoteActor(tx, {
        username: "expiredremote",
        name: "Expired",
        host: "remote.example",
      });
      const activeRemote = await insertRemoteActor(tx, {
        username: "activeremote",
        name: "Active",
        host: "remote.example",
      });
      const expiredLocal = await insertAccountWithActor(tx, {
        username: "expiredlocal",
        name: "Local",
        email: "expiredlocal@example.com",
      });
      const now = Date.now();
      await tx.update(actorTable)
        .set({
          suspended: new Date(now - 3 * HOUR),
          suspendedUntil: new Date(now - HOUR),
        })
        .where(eq(actorTable.id, expiredRemote.id));
      await tx.update(actorTable)
        .set({
          suspended: new Date(now - HOUR),
          suspendedUntil: new Date(now + HOUR),
        })
        .where(eq(actorTable.id, activeRemote.id));
      await tx.update(actorTable)
        .set({
          suspended: new Date(now - 3 * HOUR),
          suspendedUntil: new Date(now - HOUR),
        })
        .where(eq(actorTable.id, expiredLocal.actor.id));
      const count = await enqueueExpiredSuspensionRescores(
        tx,
        new Date(now - 2 * HOUR),
      );
      assert.equal(count, 1);
      const queued = await tx.query.newsRescoreQueueTable.findMany({});
      assert.ok(queued.some((q) => q.actorId === expiredRemote.id));
      assert.ok(!queued.some((q) => q.actorId === activeRemote.id));
      assert.ok(!queued.some((q) => q.actorId === expiredLocal.actor.id));
    });
  });
});

describe("sweepExpiredSuspensionRescores()", () => {
  it("uses a durable watermark in admin_state", async () => {
    await withRollback(async (tx) => {
      const now = Date.now();
      const longExpired = await insertRemoteActor(tx, {
        username: "longexpired",
        name: "Long expired",
        host: "remote.example",
      });
      // Expired well before any 10-minute fallback window:
      await tx.update(actorTable)
        .set({
          suspended: new Date(now - 10 * 24 * HOUR),
          suspendedUntil: new Date(now - 5 * 24 * HOUR),
        })
        .where(eq(actorTable.id, longExpired.id));
      // Simulate a worker that last swept before that expiry:
      await tx.insert(adminStateTable).values({
        key: "expiredSuspensionRescoreSweep",
        value: new Date(now - 7 * 24 * HOUR).toISOString(),
      });
      const count = await sweepExpiredSuspensionRescores(tx);
      assert.equal(count, 1);
      const queued = await tx.query.newsRescoreQueueTable.findMany({});
      assert.ok(queued.some((q) => q.actorId === longExpired.id));
      // The watermark advanced:
      const state = await tx.query.adminStateTable.findFirst({
        where: { key: "expiredSuspensionRescoreSweep" },
      });
      assert.ok(state != null);
      assert.ok(new Date(state.value).getTime() >= now - 1000);
    });
  });
});

describe("listSanctionedActors()", () => {
  it("lists only actively sanctioned actors", async () => {
    await withRollback(async (tx) => {
      const { fedCtx } = recordingFedCtx(tx);
      const moderator = await makeModerator(tx);
      const { flag, targetActor } = await makeReportedPostCase(tx);
      const before = await listSanctionedActors(tx);
      assert.ok(!before.some((a) => a.id === targetActor.id));
      await takeModerationAction(fedCtx, {
        caseId: flag.caseId,
        moderator: moderator.account,
        actionType: "ban",
        violatedProvisions: ["2.3"],
        rationale: "Ban.",
      });
      const after = await listSanctionedActors(tx);
      assert.ok(after.some((a) => a.id === targetActor.id));
    });
  });
});
