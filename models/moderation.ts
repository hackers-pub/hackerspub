import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { and, eq, inArray, sql } from "drizzle-orm";
import { toRecipient } from "./actor.ts";
import type { ContextData } from "./context.ts";
import type { Database, Transaction } from "./db.ts";
import { createActionTakenNotification } from "./moderation-notification.ts";
import {
  type Account,
  type Actor,
  actorTable,
  adminStateTable,
  type Flag,
  type FlagAction,
  flagActionTable,
  type FlagActionType,
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
   * report is forwarded to the target's remote instance.  Falls back to
   * `rationale`.  Both are moderator-authored by construction: the
   * reporter's original reason never enters this function, so it cannot be
   * leaked to the remote instance even by accident.
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
 * without a post) or the case is not open.
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
  if (options.actionType !== "dismiss" && provisions.length < 1) {
    return undefined;
  }
  if (options.actionType === "suspend") {
    const skewAllowanceMs = 5 * 60 * 1000;
    if (
      options.suspensionStarts == null || options.suspensionEnds == null ||
      options.suspensionEnds <= options.suspensionStarts ||
      options.suspensionStarts.getTime() > Date.now() + skewAllowanceMs ||
      options.suspensionEnds.getTime() <= Date.now()
    ) {
      return undefined;
    }
  } else if (
    options.suspensionStarts != null || options.suspensionEnds != null
  ) {
    return undefined;
  }

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
    // News scores cache moderation-visible share signals on post_link;
    // queue the target actor's links for rescoring whenever this action
    // changes what is visible.  Suspensions always take effect
    // immediately (future-dated starts are rejected or clamped), so the
    // rescore sees the new state.
    let rescore = false;
    if (options.actionType === "censor") {
      const postRows = await tx.update(postTable)
        .set({ censored: now })
        .where(eq(postTable.id, flagCase.targetPostId!))
        .returning();
      // Direct linked shares carry linkId; Article boosts counted by the
      // news score are wrapper rows with sharedPostId instead.
      rescore = postRows[0]?.linkId != null ||
        postRows[0]?.sharedPostId != null;
      // A censored reply/quote stops counting toward its parent share
      // root's news mass; rescore that root's author.
      const parentIds = [
        postRows[0]?.replyTargetId,
        postRows[0]?.quotedPostId,
      ].filter((id) => id != null);
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
    } else if (options.actionType === "suspend") {
      // A start within the clock-skew allowance may still be (slightly)
      // in the future; clamp the enforcement row to the server-side now
      // so the suspension is active immediately.
      const effectiveStarts = options.suspensionStarts! <= now
        ? options.suspensionStarts!
        : now;
      await tx.update(actorTable)
        .set({
          suspended: effectiveStarts,
          suspendedUntil: options.suspensionEnds,
        })
        .where(eq(actorTable.id, flagCase.targetActorId));
      // A temporary suspension hides content (and thus news signals) only
      // for remote actors.
      rescore = flagCase.targetActor.accountId == null;
    } else if (options.actionType === "ban") {
      await tx.update(actorTable)
        .set({ suspended: now, suspendedUntil: null })
        .where(eq(actorTable.id, flagCase.targetActorId));
      rescore = true;
    }
    if (rescore) {
      await enqueueNewsRescoreInTx(tx, flagCase.targetActorId);
      // The sanctioned actor's replies/quotes on other actors' news share
      // roots also stop counting; rescore those roots' authors too.
      await enqueueNewsRescoreForChildActivity(tx, flagCase.targetActorId);
    }
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
        content: options.forwardSummary ?? options.rationale,
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
 * newest first.  Warnings expire from the visible history one year after
 * they were issued, unless another violation (a non-`dismiss` action)
 * followed within that year; heavier sanctions are retained indefinitely.
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
    with: { case: true },
    orderBy: { created: "desc" },
  });
  return actions.filter((action) => {
    if (action.actionType !== "warning") return true;
    if (now.getTime() - action.created.getTime() < YEAR_MS) return true;
    return actions.some((other) =>
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
