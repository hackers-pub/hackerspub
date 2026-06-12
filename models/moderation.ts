import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { and, eq, inArray, sql } from "drizzle-orm";
import { toRecipient } from "./actor.ts";
import type { ContextData } from "./context.ts";
import type { Database, Transaction } from "./db.ts";
import {
  createActionTakenNotification,
  createAppealReceivedNotifications,
  createAppealResolvedNotification,
} from "./moderation-notification.ts";
import {
  type Account,
  type Actor,
  actorTable,
  adminStateTable,
  type Flag,
  type FlagAction,
  flagActionTable,
  type FlagActionType,
  type FlagAppeal,
  type FlagAppealResult,
  flagAppealTable,
  type FlagCase,
  flagCaseTable,
  flagTable,
  newsRescoreQueueTable,
  postTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "moderation"]);

function isTransaction(db: Database): db is Transaction {
  return "rollback" in db;
}

/**
 * Thrown by write-path guards when a suspended actor attempts an action
 * that suspension forbids (creating posts, replying, reacting, boosting,
 * following, or voting).
 */
export class ActorSuspendedError extends Error {
  readonly actorId: Uuid;
  /** `null` for a permanent suspension (ban). */
  readonly suspendedUntil: Date | null;

  constructor(actor: Pick<Actor, "id" | "suspendedUntil">) {
    super(
      actor.suspendedUntil == null
        ? "The actor is permanently suspended."
        : `The actor is suspended until ${actor.suspendedUntil.toISOString()}.`,
    );
    this.name = "ActorSuspendedError";
    this.actorId = actor.id;
    this.suspendedUntil = actor.suspendedUntil;
  }
}

/**
 * Whether the actor is under an *active* suspension (temporary or
 * permanent) at the given instant.  Activeness is a pure time comparison;
 * expired suspensions need no cleanup writes (lazy expiry).
 */
export function isActorSuspended(
  actor: Pick<Actor, "suspended" | "suspendedUntil">,
  now: Date = new Date(),
): boolean {
  return actor.suspended != null && actor.suspended <= now &&
    (actor.suspendedUntil == null || actor.suspendedUntil > now);
}

/**
 * Whether the actor is under an active *permanent* suspension.  For local
 * accounts this means the account cannot log in at all; for remote actors
 * it is a permanent federation block.
 */
export function isActorBanned(
  actor: Pick<Actor, "suspended" | "suspendedUntil">,
  now: Date = new Date(),
): boolean {
  return isActorSuspended(actor, now) && actor.suspendedUntil == null;
}

/**
 * Throws {@link ActorSuspendedError} when the actor is under an active
 * suspension.  Call this at the top of write paths (post creation,
 * reactions, follows, boosts, votes).
 */
export function assertActorNotSuspended(
  actor: Pick<Actor, "id" | "suspended" | "suspendedUntil">,
  now: Date = new Date(),
): void {
  if (isActorSuspended(actor, now)) {
    throw new ActorSuspendedError(actor);
  }
}

/**
 * Like {@link assertActorNotSuspended}, but looks the actor up by the
 * owning account id; for write paths that have an `accountId` but no
 * hydrated actor row.  Unknown accounts pass (the caller fails on them
 * separately).
 */
export async function assertAccountActorNotSuspended(
  db: Database,
  accountId: Uuid,
  now: Date = new Date(),
): Promise<void> {
  const actor = await db.query.actorTable.findFirst({
    where: { accountId },
    columns: { id: true, suspended: true, suspendedUntil: true },
  });
  if (actor != null) assertActorNotSuspended(actor, now);
}

const OPEN_CASE_STATUSES = ["pending", "reviewing"] as const;

// Same upsert as enqueueNewsRescore in news.ts, inlined to avoid a module
// cycle (news.ts -> post.ts -> moderation.ts).
async function enqueueNewsRescoreInTx(
  db: Database,
  actorId: Uuid,
): Promise<void> {
  await db.insert(newsRescoreQueueTable)
    .values({ actorId })
    .onConflictDoUpdate({
      target: newsRescoreQueueTable.actorId,
      set: { dirty: true },
    });
}

/**
 * Queues a news rescore for the authors of news share roots (direct linked
 * shares or boost wrappers) that have replies or quotes authored by the
 * given actor, so hiding (or un-hiding) that actor's child activity is
 * reflected in the cached scores.
 */
async function enqueueNewsRescoreForChildActivity(
  db: Database,
  childAuthorActorId: Uuid,
): Promise<void> {
  const roots = await db.execute<{ actor_id: Uuid }>(sql`
    select distinct p.actor_id as actor_id
    from post p
    join post c
      on c.reply_target_id = p.id or c.quoted_post_id = p.id
    where c.actor_id = ${childAuthorActorId}
      and (p.link_id is not null or p.shared_post_id is not null)
  `);
  for (const root of roots) {
    await enqueueNewsRescoreInTx(db, root.actor_id);
  }
}

/**
 * Queues news rescores for remote actors whose temporary federation block
 * expired within the given window, so their share/reply/quote signals
 * return to the cached news scores.  Suspension expiry is lazy (a pure
 * time comparison), so nothing else fires at the expiry instant; the
 * worker calls this periodically with an overlapping window (the enqueue
 * is an idempotent upsert).  Local temporary suspensions never hid
 * content, so only remote actors are considered.
 */
const EXPIRED_SUSPENSION_SWEEP_KEY = "expiredSuspensionRescoreSweep";
const EXPIRED_SUSPENSION_SWEEP_FALLBACK_MS = 10 * 60 * 1000;

/**
 * Durable wrapper around {@link enqueueExpiredSuspensionRescores} for the
 * worker cron: tracks the last successful sweep time in `admin_state`, so
 * suspensions that expire while the worker is down are still picked up by
 * the next successful run.  The watermark advances only after the enqueue
 * succeeds; re-processing an overlap is harmless (idempotent upsert).
 */
export async function sweepExpiredSuspensionRescores(
  db: Database,
  now: Date = new Date(),
): Promise<number> {
  const state = await db.query.adminStateTable.findFirst({
    where: { key: EXPIRED_SUSPENSION_SWEEP_KEY },
  });
  const since = state == null
    ? new Date(now.getTime() - EXPIRED_SUSPENSION_SWEEP_FALLBACK_MS)
    : new Date(state.value);
  const count = await enqueueExpiredSuspensionRescores(db, since, now);
  await db.insert(adminStateTable)
    .values({
      key: EXPIRED_SUSPENSION_SWEEP_KEY,
      value: now.toISOString(),
      updated: now,
    })
    .onConflictDoUpdate({
      target: adminStateTable.key,
      set: { value: now.toISOString(), updated: now },
    });
  return count;
}

export async function enqueueExpiredSuspensionRescores(
  db: Database,
  since: Date,
  now: Date = new Date(),
): Promise<number> {
  const expired = await db.query.actorTable.findMany({
    where: {
      accountId: { isNull: true },
      suspendedUntil: { gt: since, lte: now },
    },
    columns: { id: true },
  });
  for (const actor of expired) {
    await enqueueNewsRescoreInTx(db, actor.id);
    await enqueueNewsRescoreForChildActivity(db, actor.id);
  }
  return expired.length;
}

interface ActionInputOptions {
  actionType: FlagActionType;
  violatedProvisions?: string[];
  suspensionStarts?: Date;
  suspensionEnds?: Date;
}

function validateActionInput(options: ActionInputOptions): boolean {
  const provisions = options.violatedProvisions ?? [];
  if (options.actionType !== "dismiss" && provisions.length < 1) {
    return false;
  }
  // A dismissal confirms no violation; recording provisions on it would
  // count the dismissed report as a confirmed violation in the
  // statistics (which unnest violated_provisions across all actions).
  if (options.actionType === "dismiss" && provisions.length > 0) {
    return false;
  }
  if (options.actionType === "suspend") {
    const skewAllowanceMs = 5 * 60 * 1000;
    if (
      options.suspensionStarts == null || options.suspensionEnds == null ||
      options.suspensionEnds <= options.suspensionStarts ||
      options.suspensionStarts.getTime() > Date.now() + skewAllowanceMs ||
      options.suspensionEnds.getTime() <= Date.now()
    ) {
      return false;
    }
  } else if (
    options.suspensionStarts != null || options.suspensionEnds != null
  ) {
    return false;
  }
  return true;
}

interface EnforcementCase {
  targetActorId: Uuid;
  targetPostId: Uuid | null;
  targetActor: Actor;
}

/**
 * Queues news rescores for the share roots affected by (un)hiding the
 * given post: its own author when the post is a direct linked share or a
 * boost wrapper, and the authors of its reply/quote parents when those are
 * news share roots.  Returns whether the post's own author needs a
 * rescore.
 */
async function enqueuePostNewsRescoreTargets(
  tx: Transaction,
  post: {
    linkId: Uuid | null;
    sharedPostId: Uuid | null;
    replyTargetId: Uuid | null;
    quotedPostId: Uuid | null;
  },
): Promise<boolean> {
  const parentIds = [post.replyTargetId, post.quotedPostId]
    .filter((id) => id != null);
  if (parentIds.length > 0) {
    const parents = await tx.query.postTable.findMany({
      where: { id: { in: parentIds } },
      columns: { actorId: true, linkId: true, sharedPostId: true },
    });
    for (const parent of parents) {
      if (parent.linkId != null || parent.sharedPostId != null) {
        await enqueueNewsRescoreInTx(tx, parent.actorId);
      }
    }
  }
  return post.linkId != null || post.sharedPostId != null;
}

/** Whether an action still stands: not overturned by a resolved appeal. */
function isStandingAction(
  action: { appeal: { status: string; result: string | null } | null },
): boolean {
  return action.appeal == null ||
    action.appeal.status !== "resolved" ||
    action.appeal.result === "dismissed";
}

/**
 * Whether an actor's content is hidden under the given enforcement state:
 * an active permanent suspension (ban) hides it for everyone, an active
 * temporary suspension only for remote actors.
 */
function isActorContentHidden(
  suspended: Date | null,
  suspendedUntil: Date | null,
  isRemote: boolean,
  now: Date,
): boolean {
  if (suspended == null || suspended > now) return false;
  if (suspendedUntil != null && suspendedUntil <= now) return false;
  return suspendedUntil == null || isRemote;
}

/**
 * Recomputes an actor's effective suspension from all standing `suspend`
 * and `ban` actions across the actor's cases, so withdrawing or replacing
 * one sanction never clears another that still stands (e.g. an active ban
 * from a different case).  A ban wins; otherwise the effective window spans
 * the earliest start to the latest end of the still-active suspensions.
 * Returns whether the actor's content visibility changed (for news rescore).
 */
async function recomputeActorEnforcement(
  tx: Transaction,
  actorId: Uuid,
  now: Date,
): Promise<boolean> {
  // Lock the actor row so concurrent actions/appeals on different cases for
  // the same target serialize and each recompute sees a consistent state.
  const [actor] = await tx.select({
    suspended: actorTable.suspended,
    suspendedUntil: actorTable.suspendedUntil,
    accountId: actorTable.accountId,
  })
    .from(actorTable)
    .where(eq(actorTable.id, actorId))
    .for("update");
  if (actor == null) return false;
  const isRemote = actor.accountId == null;
  const actions = await tx.query.flagActionTable.findMany({
    where: {
      case: { targetActorId: actorId },
      actionType: { in: ["suspend", "ban"] },
    },
    with: { appeal: true },
  });
  const standing = actions.filter(isStandingAction);
  let suspended: Date | null = null;
  let suspendedUntil: Date | null = null;
  if (standing.some((a) => a.actionType === "ban")) {
    suspended = standing
      .filter((a) => a.actionType === "ban")
      .map((a) => a.created)
      .reduce((earliest, d) => (d < earliest ? d : earliest));
    suspendedUntil = null;
  } else {
    const active = standing.filter((a) =>
      a.actionType === "suspend" && a.suspensionStarts != null &&
      a.suspensionEnds != null && a.suspensionEnds > now
    );
    if (active.length > 0) {
      // Clamp the earliest start to now so the suspension is active
      // immediately even if it was filed with a (skew-tolerated) future start.
      const start = active
        .map((a) => a.suspensionStarts!)
        .reduce((earliest, d) => (d < earliest ? d : earliest));
      suspended = start <= now ? start : now;
      suspendedUntil = active
        .map((a) => a.suspensionEnds!)
        .reduce((latest, d) => (d > latest ? d : latest));
    }
  }
  const hiddenBefore = isActorContentHidden(
    actor.suspended,
    actor.suspendedUntil,
    isRemote,
    now,
  );
  const hiddenAfter = isActorContentHidden(
    suspended,
    suspendedUntil,
    isRemote,
    now,
  );
  const stateChanged =
    (actor.suspended?.getTime() ?? null) !== (suspended?.getTime() ?? null) ||
    (actor.suspendedUntil?.getTime() ?? null) !==
      (suspendedUntil?.getTime() ?? null);
  if (stateChanged) {
    await tx.update(actorTable)
      .set({ suspended, suspendedUntil })
      .where(eq(actorTable.id, actorId));
  }
  return hiddenBefore !== hiddenAfter;
}

/**
 * Recomputes a post's censorship from all standing `censor` actions on it,
 * so withdrawing one censor never un-hides a post another standing censor
 * still covers.  Returns whether the post's author needs a news rescore.
 */
async function recomputePostEnforcement(
  tx: Transaction,
  postId: Uuid,
): Promise<boolean> {
  // Lock the post row so concurrent censor actions/appeals on it serialize.
  const [locked] = await tx.select({ censored: postTable.censored })
    .from(postTable)
    .where(eq(postTable.id, postId))
    .for("update");
  if (locked == null) return false;
  const actions = await tx.query.flagActionTable.findMany({
    where: { actionType: "censor", case: { targetPostId: postId } },
    with: { appeal: true },
  });
  const standing = actions.filter(isStandingAction);
  const censored = standing.length > 0
    ? standing.map((a) => a.created).reduce((earliest, d) =>
      d < earliest ? d : earliest
    )
    : null;
  if ((locked.censored?.getTime() ?? null) === (censored?.getTime() ?? null)) {
    return false;
  }
  const postRows = await tx.update(postTable)
    .set({ censored })
    .where(eq(postTable.id, postId))
    .returning();
  return postRows[0] != null
    ? await enqueuePostNewsRescoreTargets(tx, postRows[0])
    : false;
}

/**
 * Applies a moderation action's enforcement by recomputing the effective
 * state of its target from every standing action: `censor` recomputes
 * `post.censored`, `suspend`/`ban` recompute the target actor's suspension.
 * News scores cache moderation-visible share signals on `post_link`, so a
 * visibility change is queued for rescoring.
 */
async function applyActionEnforcement(
  tx: Transaction,
  flagCase: EnforcementCase,
  action: Pick<FlagAction, "actionType">,
  now: Date,
): Promise<void> {
  let rescore = false;
  if (action.actionType === "censor") {
    rescore = await recomputePostEnforcement(tx, flagCase.targetPostId!);
  } else if (action.actionType === "suspend" || action.actionType === "ban") {
    rescore = await recomputeActorEnforcement(tx, flagCase.targetActorId, now);
  }
  if (rescore) {
    await enqueueNewsRescoreInTx(tx, flagCase.targetActorId);
    // The sanctioned actor's replies/quotes on other actors' news share
    // roots also stop counting; rescore those roots' authors too.
    await enqueueNewsRescoreForChildActivity(tx, flagCase.targetActorId);
  }
}

/**
 * Reverts a moderation action's enforcement (for appeal outcomes that
 * withdraw or replace it) by recomputing the target's effective state from
 * the remaining standing actions, so other still-standing sanctions are
 * preserved.  The appeal's resolution must already be persisted so the
 * appealed action is excluded.
 */
async function revertActionEnforcement(
  tx: Transaction,
  flagCase: EnforcementCase,
  action: Pick<FlagAction, "actionType">,
  now: Date,
): Promise<void> {
  let rescore = false;
  if (action.actionType === "censor") {
    if (flagCase.targetPostId != null) {
      rescore = await recomputePostEnforcement(tx, flagCase.targetPostId);
    }
  } else if (action.actionType === "suspend" || action.actionType === "ban") {
    rescore = await recomputeActorEnforcement(tx, flagCase.targetActorId, now);
  }
  if (rescore) {
    await enqueueNewsRescoreInTx(tx, flagCase.targetActorId);
    await enqueueNewsRescoreForChildActivity(tx, flagCase.targetActorId);
  }
}

export interface TakeModerationActionOptions {
  /** The case to act on; it must still be open (pending or reviewing). */
  caseId: Uuid;
  /** The acting moderator.  Recorded for the internal audit trail only. */
  moderator: Account;
  actionType: FlagActionType;
  /**
   * The code of conduct provisions the moderator confirmed as violated.
   * Required (non-empty) for every action type except `dismiss`.
   */
  violatedProvisions?: string[];
  /**
   * The moderator's internal judgment rationale.  May contain details not
   * appropriate to share with the reported user; those go to
   * `messageToUser`.
   */
  rationale: string;
  /** The message shown to the reported user, if any. */
  messageToUser?: string;
  /**
   * Suspension window; required for (and only for) `suspend` actions.
   * `suspensionStarts` must not be in the future (beyond a small
   * clock-skew allowance): enforcement state and cached aggregates (news
   * scores) change at action time, so scheduled future suspensions are
   * not supported.
   */
  suspensionStarts?: Date;
  suspensionEnds?: Date;
  /**
   * Moderator-written summary for the outgoing `Flag` activity when the
   * report is forwarded to the target's remote instance.  Required
   * (non-empty) for a non-dismiss action whose case will forward (remote
   * target with an opted-in report): the action is rejected otherwise, and
   * the outgoing `Flag` carries this summary verbatim with no fallback, so
   * the internal `rationale` is never externalized.
   */
  forwardSummary?: string;
}

/**
 * Records a moderation decision on an open case and applies its effects,
 * all in one transaction:
 *
 * - inserts the immutable `flag_action` audit record;
 * - resolves the case (`dismiss` dismisses it) and its member flags;
 * - applies enforcement state (`censor` sets `post.censored`; `suspend`
 *   writes the suspension window onto the target actor; `ban` suspends
 *   permanently) and queues a news rescore when censoring a linked post;
 * - notifies the reported user (for dismissals only when the moderator
 *   wrote a message, at their discretion).
 *
 * After the transaction, when the target is remote, at least one reporter
 * opted in to forwarding, and the action is not a dismissal, a `Flag`
 * activity is sent to the remote instance from the *instance actor* (never
 * a personal actor), carrying only the moderator-written summary.
 *
 * Returns `undefined` when the input is invalid (non-moderator, missing
 * provisions, missing or inverted suspension window, censoring a case
 * without a post, or a non-dismiss action that would forward to a remote
 * instance without a `forwardSummary`) or the case is not open.
 */
export async function takeModerationAction(
  fedCtx: Context<ContextData>,
  options: TakeModerationActionOptions,
): Promise<FlagAction | undefined> {
  const { db } = fedCtx.data;
  const provisions = options.violatedProvisions ?? [];
  if (!options.moderator.moderator) {
    logger.warn(
      "Non-moderator account {accountId} attempted a moderation action.",
      { accountId: options.moderator.id },
    );
    return undefined;
  }
  if (!validateActionInput(options)) return undefined;

  const run = async (
    tx: Transaction,
  ): Promise<
    | {
      action: FlagAction;
      flagCase: FlagCase & { flags: Flag[]; targetActor: Actor };
    }
    | undefined
  > => {
    // Lock the case row so concurrent actions (or a report joining the
    // case) serialize against this resolution.
    const [locked] = await tx.select()
      .from(flagCaseTable)
      .where(and(
        eq(flagCaseTable.id, options.caseId),
        inArray(flagCaseTable.status, [...OPEN_CASE_STATUSES]),
      ))
      .for("update");
    if (locked == null) return undefined;
    const flagCase = await tx.query.flagCaseTable.findFirst({
      where: { id: options.caseId },
      with: { flags: true, targetActor: true },
    });
    if (flagCase == null) return undefined;
    if (options.actionType === "censor" && flagCase.targetPostId == null) {
      logger.debug(
        "Cannot censor case {caseId}: no post target.",
        { caseId: flagCase.id },
      );
      return undefined;
    }
    // A forwarded `Flag` carries only the moderator-written summary, never
    // the internal `rationale`.  Decide forwarding here, under the case
    // lock, so a `forwardToRemote` report joining the case cannot slip a
    // summary-less action past a caller's pre-check; reject when a summary
    // is required but missing.
    const willForward = options.actionType !== "dismiss" &&
      flagCase.targetActor.accountId == null &&
      flagCase.flags.some((flag) => flag.forwardToRemote);
    if (
      willForward &&
      (options.forwardSummary == null ||
        options.forwardSummary.trim() === "")
    ) {
      logger.debug(
        "Cannot forward case {caseId} without a summary.",
        { caseId: flagCase.id },
      );
      return undefined;
    }
    const now = new Date();
    // Re-validate the suspension window against the post-lock clock: the
    // FOR UPDATE wait can outlast a near-term window, which must not
    // produce an already-expired enforcement row.
    if (
      options.actionType === "suspend" && options.suspensionEnds! <= now
    ) {
      return undefined;
    }
    const actionRows = await tx.insert(flagActionTable)
      .values({
        id: generateUuidV7(),
        caseId: flagCase.id,
        moderatorId: options.moderator.id,
        actionType: options.actionType,
        violatedProvisions: provisions,
        rationale: options.rationale,
        messageToUser: options.messageToUser,
        suspensionStarts: options.suspensionStarts,
        suspensionEnds: options.suspensionEnds,
        created: now,
      })
      .returning();
    const action = actionRows[0];
    const caseStatus = options.actionType === "dismiss"
      ? "dismissed" as const
      : "resolved" as const;
    await tx.update(flagCaseTable)
      .set({ status: caseStatus, resolved: now })
      .where(eq(flagCaseTable.id, flagCase.id));
    await tx.update(flagTable)
      .set({ status: caseStatus, updated: now })
      .where(and(
        eq(flagTable.caseId, flagCase.id),
        inArray(flagTable.status, [...OPEN_CASE_STATUSES]),
      ));
    await applyActionEnforcement(tx, flagCase, action, now);
    const targetAccountId = flagCase.targetActor.accountId;
    if (
      targetAccountId != null &&
      (options.actionType !== "dismiss" || options.messageToUser != null)
    ) {
      await createActionTakenNotification(tx, targetAccountId, action);
    }
    return { action, flagCase };
  };

  const result = isTransaction(db) ? await run(db) : await db.transaction(run);
  if (result == null) return undefined;
  const { action, flagCase } = result;
  const targetActor = flagCase.targetActor;
  // `run` already rejected a forwardable non-dismiss action without a
  // summary, so `options.forwardSummary` is guaranteed non-empty here.
  if (
    action.actionType !== "dismiss" &&
    targetActor.accountId == null &&
    flagCase.flags.some((flag) => flag.forwardToRemote)
  ) {
    const identifier = new URL(fedCtx.canonicalOrigin).hostname;
    await fedCtx.sendActivity(
      { identifier },
      toRecipient(targetActor),
      new vocab.Flag({
        id: new URL(`/ap/flags/${action.id}`, fedCtx.canonicalOrigin),
        actor: fedCtx.getActorUri(identifier),
        objects: [
          new URL(targetActor.iri),
          ...(flagCase.targetPostIri == null
            ? []
            : [new URL(flagCase.targetPostIri)]),
        ],
        content: options.forwardSummary,
      }),
      { excludeBaseUris: [new URL(fedCtx.canonicalOrigin)] },
    );
  }
  return action;
}

/**
 * Assigns the case to a moderator (or unassigns it with `null`) for
 * workload distribution.  Assigning a pending case moves it to
 * `reviewing`.  Only open cases can be (re)assigned; returns `undefined`
 * otherwise.
 */
export async function assignCase(
  db: Database,
  caseId: Uuid,
  moderatorId: Uuid | null,
): Promise<FlagCase | undefined> {
  if (moderatorId != null) {
    const assignee = await db.query.accountTable.findFirst({
      where: { id: moderatorId },
      columns: { moderator: true },
    });
    if (assignee == null || !assignee.moderator) return undefined;
  }
  const rows = await db.update(flagCaseTable)
    .set(
      moderatorId == null ? { assignedModeratorId: null } : {
        assignedModeratorId: moderatorId,
        status: "reviewing",
      },
    )
    .where(and(
      eq(flagCaseTable.id, caseId),
      inArray(flagCaseTable.status, [...OPEN_CASE_STATUSES]),
    ))
    .returning();
  return rows[0];
}

/**
 * Moves an open case between `pending` and `reviewing`.  Resolution
 * happens exclusively through {@link takeModerationAction}; returns
 * `undefined` for closed cases.
 */
export async function updateCaseStatus(
  db: Database,
  caseId: Uuid,
  status: "pending" | "reviewing",
): Promise<FlagCase | undefined> {
  const rows = await db.update(flagCaseTable)
    .set({ status })
    .where(and(
      eq(flagCaseTable.id, caseId),
      inArray(flagCaseTable.status, [...OPEN_CASE_STATUSES]),
    ))
    .returning();
  return rows[0];
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * The target actor's moderation history (actions on cases targeting them),
 * newest first.  Excluded: dismissals, actions whose appeal withdrew or
 * replaced them (`withdrawn`, `reduced`, `increased`; the replacement
 * action appears instead), and warnings older than one year with no
 * subsequent violation within that year.  Heavier sanctions are retained
 * indefinitely; an action whose appeal was `dismissed` or is still open
 * remains in the history.
 */
export async function getViolationHistory(
  db: Database,
  targetActorId: Uuid,
  now: Date = new Date(),
): Promise<(FlagAction & { case: FlagCase })[]> {
  const actions = await db.query.flagActionTable.findMany({
    where: {
      case: { targetActorId },
      actionType: { ne: "dismiss" },
    },
    with: { case: true, appeal: true },
    orderBy: { created: "desc" },
  });
  const standing = actions.filter((action) =>
    action.appeal == null ||
    action.appeal.status !== "resolved" ||
    action.appeal.result === "dismissed"
  );
  return standing.filter((action) => {
    if (action.actionType !== "warning") return true;
    if (now.getTime() - action.created.getTime() < YEAR_MS) return true;
    return standing.some((other) =>
      other.id !== action.id &&
      other.actionType !== "dismiss" &&
      other.created > action.created &&
      other.created.getTime() - action.created.getTime() <= YEAR_MS
    );
  });
}

/**
 * Lists actors currently under an active sanction (temporary or
 * permanent), most recently sanctioned first.
 */
export function listSanctionedActors(
  db: Database,
  now: Date = new Date(),
): Promise<(Actor & { account: Account | null })[]> {
  return db.query.actorTable.findMany({
    where: {
      suspended: { lte: now },
      OR: [
        { suspendedUntil: { isNull: true } },
        { suspendedUntil: { gt: now } },
      ],
    },
    with: { account: true },
    orderBy: { suspended: "desc" },
  }) as Promise<(Actor & { account: Account | null })[]>;
}

/**
 * How long after an action the sanctioned user can appeal it: 14 days.
 */
export const APPEAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface CreateAppealOptions {
  /** The action being appealed. */
  actionId: Uuid;
  /**
   * The appellant.  Appeals are filed in-app, so only local users can
   * appeal, and only the sanctioned user themselves.
   */
  appellant: Account;
  /** Why the appellant believes the action is unjust. */
  reason: string;
  /** Context or evidence the appellant believes was not considered. */
  additionalContext?: string;
}

/**
 * Files an appeal against a moderation action and notifies moderators.
 *
 * Returns `undefined` when the action does not exist or is a dismissal
 * (there is no sanction to appeal), the appellant is not the sanctioned
 * user, the 14-day window has passed, the reason is empty, or the action
 * was already appealed (one appeal per action).
 */
export async function createAppeal(
  db: Database,
  options: CreateAppealOptions,
): Promise<FlagAppeal | undefined> {
  const reason = options.reason.trim();
  if (reason.length < 1) return undefined;
  // One transaction so a failed notification fan-out cannot strand a
  // committed appeal whose retry would then hit the one-appeal-per-action
  // unique constraint.
  const run = async (tx: Transaction): Promise<FlagAppeal | undefined> => {
    const action = await tx.query.flagActionTable.findFirst({
      where: { id: options.actionId },
      with: { case: { with: { targetActor: true } } },
    });
    if (action == null || action.actionType === "dismiss") return undefined;
    if (action.case.targetActor.accountId !== options.appellant.id) {
      return undefined;
    }
    if (Date.now() - action.created.getTime() > APPEAL_WINDOW_MS) {
      logger.debug(
        "Appeal window for action {actionId} has passed.",
        { actionId: action.id },
      );
      return undefined;
    }
    const rows = await tx.insert(flagAppealTable)
      .values({
        id: generateUuidV7(),
        actionId: action.id,
        appellantId: options.appellant.id,
        reason,
        additionalContext: options.additionalContext,
      })
      .onConflictDoNothing()
      .returning();
    if (rows.length < 1) return undefined;
    await createAppealReceivedNotifications(tx, rows[0]);
    return rows[0];
  };
  return isTransaction(db) ? await run(db) : await db.transaction(run);
}

export interface ResolveAppealOptions {
  appealId: Uuid;
  /**
   * The reviewing moderator.  Preferably different from the moderator who
   * took the original action; the caller surfaces that, this function
   * does not enforce it.
   */
  reviewer: Account;
  result: FlagAppealResult;
  /** The reviewer's rationale, shown to the appellant. */
  reviewRationale: string;
  /**
   * The replacement sanction; required for (and only for) `reduced` and
   * `increased` results, which revert the original enforcement and record
   * a new immutable action on the same case.
   */
  replacement?: {
    actionType: Exclude<FlagActionType, "dismiss">;
    violatedProvisions: string[];
    rationale: string;
    messageToUser?: string;
    suspensionStarts?: Date;
    suspensionEnds?: Date;
  };
}

/**
 * Resolves an appeal, in one transaction:
 *
 * - `dismissed` keeps the original action and its enforcement;
 * - `withdrawn` reverts the original enforcement (un-censors the post or
 *   lifts the suspension);
 * - `reduced` and `increased` revert the original enforcement and record
 *   a *new* immutable `flag_action` (authored by the reviewer) on the
 *   same case, applying its enforcement instead;
 *
 * then notifies the appellant.  Returns `undefined` when the reviewer is
 * not a moderator, the appeal is not open, or the replacement is missing
 * or invalid.
 */
export async function resolveAppeal(
  db: Database,
  options: ResolveAppealOptions,
): Promise<FlagAppeal | undefined> {
  if (!options.reviewer.moderator) {
    logger.warn(
      "Non-moderator account {accountId} attempted to resolve an appeal.",
      { accountId: options.reviewer.id },
    );
    return undefined;
  }
  const needsReplacement = options.result === "reduced" ||
    options.result === "increased";
  if (needsReplacement !== (options.replacement != null)) return undefined;
  if (
    options.replacement != null && !validateActionInput(options.replacement)
  ) {
    return undefined;
  }

  const run = async (tx: Transaction): Promise<FlagAppeal | undefined> => {
    const [locked] = await tx.select()
      .from(flagAppealTable)
      .where(and(
        eq(flagAppealTable.id, options.appealId),
        inArray(flagAppealTable.status, ["pending", "reviewing"]),
      ))
      .for("update");
    if (locked == null) return undefined;
    const appeal = await tx.query.flagAppealTable.findFirst({
      where: { id: options.appealId },
      with: {
        action: { with: { case: { with: { targetActor: true } } } },
      },
    });
    if (appeal == null) return undefined;
    const flagCase = appeal.action.case;
    const now = new Date();
    if (
      options.replacement?.actionType === "censor" &&
      flagCase.targetPostId == null
    ) {
      return undefined;
    }
    // Re-validate a replacement suspension window against the post-lock
    // clock, mirroring takeModerationAction: the FOR UPDATE wait can
    // outlast a near-term window.
    if (
      options.replacement?.actionType === "suspend" &&
      options.replacement.suspensionEnds! <= now
    ) {
      return undefined;
    }
    const appealRows = await tx.update(flagAppealTable)
      .set({
        status: "resolved",
        result: options.result,
        reviewerId: options.reviewer.id,
        reviewRationale: options.reviewRationale,
        resolved: now,
      })
      .where(eq(flagAppealTable.id, appeal.id))
      .returning();
    if (options.result === "withdrawn") {
      await revertActionEnforcement(tx, flagCase, appeal.action, now);
    } else if (options.replacement != null) {
      await revertActionEnforcement(tx, flagCase, appeal.action, now);
      const replacementRows = await tx.insert(flagActionTable)
        .values({
          id: generateUuidV7(),
          caseId: flagCase.id,
          moderatorId: options.reviewer.id,
          actionType: options.replacement.actionType,
          violatedProvisions: options.replacement.violatedProvisions,
          rationale: options.replacement.rationale,
          messageToUser: options.replacement.messageToUser,
          suspensionStarts: options.replacement.suspensionStarts,
          suspensionEnds: options.replacement.suspensionEnds,
          created: now,
        })
        .returning();
      await applyActionEnforcement(tx, flagCase, replacementRows[0], now);
    }
    await createAppealResolvedNotification(
      tx,
      appeal.appellantId,
      appealRows[0],
    );
    return appealRows[0];
  };
  return isTransaction(db) ? await run(db) : await db.transaction(run);
}

export interface ModerationActionCount {
  actionType: FlagActionType;
  count: number;
}

export interface ModerationProvisionCount {
  provision: string;
  count: number;
}

export interface ModerationLlmDivergence {
  /** How many analyzed reports on closed cases were compared. */
  compared: number;
  /**
   * How many of them had LLM-suggested provisions that differ from the
   * moderator-confirmed set.
   */
  diverged: number;
}

export interface ModerationStatistics {
  /** Reports filed in the range. */
  totalReports: number;
  /** Reports whose processing finished (resolved or dismissed). */
  processedReports: number;
  /**
   * Average hours from a case's creation to its resolution, over cases
   * created in the range; `null` when no case has been resolved.
   */
  averageProcessingHours: number | null;
  /** How taken actions distribute over the action types. */
  actionDistribution: ModerationActionCount[];
  /** The five most-confirmed code of conduct provisions. */
  topViolatedProvisions: ModerationProvisionCount[];
  /**
   * The divergence between LLM-suggested and moderator-confirmed
   * provisions.  High divergence localized to particular provisions or
   * groups signals unreliable or biased matching; near-zero divergence is
   * also a warning sign (automation bias: moderators rubber-stamping LLM
   * output).  `null` when no analyzed report has been processed yet.
   */
  llmDivergence: ModerationLlmDivergence | null;
}

/**
 * Aggregates the moderation activity in the given range (defaults to all
 * time) for the moderator statistics screen.
 */
export async function getModerationStatistics(
  db: Database,
  range: { since?: Date; until?: Date } = {},
): Promise<ModerationStatistics> {
  // Raw `sql` does not bind a JS `Date`; pass ISO strings cast to
  // `timestamptz` (same workaround as models/news.ts).
  const since = sql`${(range.since ?? new Date(0)).toISOString()}::timestamptz`;
  const until = sql`${(range.until ?? new Date()).toISOString()}::timestamptz`;
  const [reportCounts] = await db.execute<
    { total: string | number; processed: string | number }
  >(sql`
    select
      count(*) as total,
      count(*) filter (where status in ('resolved', 'dismissed'))
        as processed
    from flag
    where created >= ${since} and created <= ${until}
  `);
  const [avgRow] = await db.execute<{ avg_hours: string | number | null }>(
    sql`
      select
        avg(extract(epoch from (resolved - created)) / 3600.0) as avg_hours
      from flag_case
      where resolved is not null
        and created >= ${since} and created <= ${until}
    `,
  );
  const distribution = await db.execute<
    { action_type: FlagActionType; cnt: string | number }
  >(sql`
    select action_type, count(*) as cnt
    from flag_action
    where created >= ${since} and created <= ${until}
    group by action_type
    order by cnt desc, action_type
  `);
  // Actions withdrawn or replaced on appeal no longer stand; they drop
  // out of the provision counts (mirroring getViolationHistory).
  const provisions = await db.execute<
    { provision: string; cnt: string | number }
  >(sql`
    select p.provision as provision, count(*) as cnt
    from flag_action a
    left join flag_appeal ap
      on ap.action_id = a.id
      and ap.status = 'resolved'
      and ap.result in ('withdrawn', 'reduced', 'increased'),
      lateral unnest(a.violated_provisions) as p(provision)
    where a.created >= ${since} and a.created <= ${until}
      and ap.id is null
    group by p.provision
    order by cnt desc, p.provision
    limit 5
  `);
  // LLM divergence: per analyzed report on a closed case, compare the
  // LLM-suggested provision set with the union of the case's
  // moderator-confirmed provisions (empty for dismissals).  Computed in
  // JS: the joined volume is the number of analyzed reports, which stays
  // modest.
  const analyzedFlags = await db.query.flagTable.findMany({
    where: {
      llmAnalysis: { isNotNull: true },
      created: {
        gte: range.since ?? new Date(0),
        lte: range.until ?? new Date(),
      },
      case: { status: { in: ["resolved", "dismissed"] } },
    },
    columns: { llmAnalysis: true },
    with: { case: { with: { actions: { with: { appeal: true } } } } },
  });
  let compared = 0;
  let diverged = 0;
  for (const flag of analyzedFlags) {
    // A failed analysis (error set, no matches) says nothing about the
    // LLM's judgment; counting it would inflate divergence.
    if (flag.llmAnalysis?.error != null) continue;
    const confirmed = new Set(
      flag.case.actions
        .filter((action) =>
          action.actionType !== "dismiss" &&
          (action.appeal == null ||
            action.appeal.status !== "resolved" ||
            action.appeal.result === "dismissed")
        )
        .flatMap((action) => action.violatedProvisions),
    );
    const suggested = new Set(
      (flag.llmAnalysis?.matches ?? []).map((match) => match.provision),
    );
    compared++;
    const equal = confirmed.size === suggested.size &&
      [...confirmed].every((provision) => suggested.has(provision));
    if (!equal) diverged++;
  }
  return {
    totalReports: Number(reportCounts?.total ?? 0),
    processedReports: Number(reportCounts?.processed ?? 0),
    averageProcessingHours: avgRow?.avg_hours == null
      ? null
      : Number(avgRow.avg_hours),
    actionDistribution: distribution.map((row) => ({
      actionType: row.action_type,
      count: Number(row.cnt),
    })),
    topViolatedProvisions: provisions.map((row) => ({
      provision: row.provision,
      count: Number(row.cnt),
    })),
    llmDivergence: compared === 0 ? null : { compared, diverged },
  };
}
