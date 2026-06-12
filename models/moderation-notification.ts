import { and, count, eq, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import {
  type Account,
  type Actor,
  type FlagAction,
  type FlagAppeal,
  type FlagCase,
  type ModerationNotification,
  moderationNotificationTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

/**
 * A moderation notification with its referenced moderation entities
 * hydrated.
 */
export type ModerationNotificationWithRefs = ModerationNotification & {
  case: FlagCase | null;
  action: FlagAction | null;
  appeal: FlagAppeal | null;
};

/**
 * Notifies every moderator that a new report was filed on the given case.
 *
 * To avoid flooding the moderation queue when several users report the same
 * target, a moderator who already has an *unread* `flag_received`
 * notification for the case is not notified again: the partial unique index
 * `moderation_notification_flag_received_idx` makes the duplicate insert a
 * no-op, even under concurrent reports.
 */
export async function createFlagReceivedNotifications(
  db: Database,
  flagCase: FlagCase,
): Promise<ModerationNotification[]> {
  // A reported moderator must not learn about reports against
  // themselves: they are excluded from their own case's notifications
  // (and from accessing the case, in the GraphQL layer).
  const moderators = await db.query.accountTable.findMany({
    where: {
      moderator: true,
      NOT: { actor: { id: flagCase.targetActorId } },
    },
    columns: { id: true },
  });
  if (moderators.length < 1) return [];
  return await db.insert(moderationNotificationTable)
    .values(moderators.map((moderator) => ({
      id: generateUuidV7(),
      accountId: moderator.id,
      type: "flag_received" as const,
      caseId: flagCase.id,
    })))
    .onConflictDoNothing()
    .returning();
}

/**
 * Notifies the reported user that a moderation action was taken on them.
 * The notification carries only the action reference; the rendering layer
 * presents it under the moderation team's collective identity and never
 * reveals the acting moderator, the reporters, or the report count.
 */
export async function createActionTakenNotification(
  db: Database,
  accountId: Uuid,
  action: FlagAction,
): Promise<ModerationNotification | undefined> {
  const rows = await db.insert(moderationNotificationTable)
    .values({
      id: generateUuidV7(),
      accountId,
      type: "action_taken",
      actionId: action.id,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0];
}

/**
 * Notifies every moderator that an appeal was filed.  Called once per
 * appeal (appeals are unique per action), so no deduplication is needed.
 */
export async function createAppealReceivedNotifications(
  db: Database,
  appeal: FlagAppeal,
): Promise<ModerationNotification[]> {
  const moderators = await db.query.accountTable.findMany({
    where: { moderator: true },
    columns: { id: true },
  });
  if (moderators.length < 1) return [];
  return await db.insert(moderationNotificationTable)
    .values(moderators.map((moderator) => ({
      id: generateUuidV7(),
      accountId: moderator.id,
      type: "appeal_received" as const,
      appealId: appeal.id,
    })))
    .onConflictDoNothing()
    .returning();
}

/**
 * Notifies the appellant that their appeal was resolved.  Like every
 * notification to a sanctioned user, the rendering layer presents it under
 * the moderation team's collective identity.
 */
export async function createAppealResolvedNotification(
  db: Database,
  accountId: Uuid,
  appeal: FlagAppeal,
): Promise<ModerationNotification | undefined> {
  const rows = await db.insert(moderationNotificationTable)
    .values({
      id: generateUuidV7(),
      accountId,
      type: "appeal_resolved",
      appealId: appeal.id,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0];
}

/**
 * Lists the account's moderation notifications, newest first, with their
 * referenced case/action/appeal hydrated.
 */
export function getModerationNotifications(
  db: Database,
  accountId: Uuid,
  options: { limit?: number; until?: Date } = {},
): Promise<ModerationNotificationWithRefs[]> {
  return db.query.moderationNotificationTable.findMany({
    where: {
      accountId,
      ...(options.until == null ? {} : { created: { lte: options.until } }),
    },
    with: { case: true, action: true, appeal: true },
    orderBy: { created: "desc" },
    limit: options.limit,
  }) as Promise<ModerationNotificationWithRefs[]>;
}

/**
 * Counts the account's unread moderation notifications, e.g. for the
 * sidebar badge.
 */
export async function countUnreadModerationNotifications(
  db: Database,
  accountId: Uuid,
): Promise<number> {
  const rows = await db.select({ count: count() })
    .from(moderationNotificationTable)
    .where(and(
      eq(moderationNotificationTable.accountId, accountId),
      isNull(moderationNotificationTable.read),
    ));
  return rows[0].count;
}

/**
 * Marks the account's unread moderation notifications as read (optionally
 * only those created up to the notification with the given id) and
 * returns how many were affected.  Idempotent.
 *
 * The boundary is a notification *id*, not a `Date`: PostgreSQL keeps
 * microseconds while a JavaScript `Date` only carries milliseconds, so a
 * round-tripped timestamp could fail to cover the boundary row.  The
 * comparison uses the stored `created` value via a subquery instead.  An
 * `upToId` that does not belong to the account marks nothing.
 */
export async function markModerationNotificationsRead(
  db: Database,
  accountId: Uuid,
  upToId?: Uuid,
): Promise<number> {
  const rows = await db.update(moderationNotificationTable)
    .set({ read: new Date() })
    .where(and(
      eq(moderationNotificationTable.accountId, accountId),
      isNull(moderationNotificationTable.read),
      ...(upToId == null ? [] : [
        lte(
          moderationNotificationTable.created,
          sql`(
            select n.created from moderation_notification n
            where n.id = ${upToId} and n.account_id = ${accountId}
          )`,
        ),
      ]),
    ))
    .returning({ id: moderationNotificationTable.id });
  return rows.length;
}

/**
 * How close to a temporary suspension's end the `suspension_ending`
 * notification is created: 24 hours.
 */
export const SUSPENSION_ENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Lazily creates the `suspension_ending` notification for a temporarily
 * suspended account whose suspension ends within the next 24 hours.
 * Suspension expiry is a pure time comparison with no scheduler, so the
 * server calls this when building the request context for a suspended
 * viewer; the partial unique index on (`account_id`, `action_id`)
 * deduplicates repeated calls.  A user who never visits during the window
 * simply gets no advance notice, which is acceptable: their suspension
 * lifts on its own.
 *
 * Returns the created notification, or `undefined` when none is due (not
 * suspended, no end, too early, already passed) or it already exists.
 */
export async function ensureSuspensionEndingNotification(
  db: Database,
  account: Account & { actor: Actor },
  now: Date = new Date(),
): Promise<ModerationNotification | undefined> {
  const { suspended, suspendedUntil } = account.actor;
  if (suspended == null || suspendedUntil == null) return undefined;
  if (suspendedUntil <= now) return undefined;
  if (suspendedUntil.getTime() - now.getTime() > SUSPENSION_ENDING_WINDOW_MS) {
    return undefined;
  }
  // The actor's effective suspendedUntil is recomputed as the latest end of
  // the still-standing suspensions (see recomputeActorEnforcement in
  // moderation.ts), so the action that actually ends then is the one whose
  // suspensionEnds matches it; a newer, shorter or overturned suspension
  // must not be referenced.
  const candidates = await db.query.flagActionTable.findMany({
    where: {
      actionType: "suspend",
      case: { targetActorId: account.actor.id },
      suspensionEnds: { eq: suspendedUntil },
    },
    with: { appeal: true },
    orderBy: { created: "desc" },
  });
  // Same standing test as isStandingAction in moderation.ts (not imported:
  // moderation.ts already imports this module).
  const action = candidates.find((a) =>
    a.appeal == null || a.appeal.status !== "resolved" ||
    a.appeal.result === "dismissed"
  );
  if (action == null) return undefined;
  const rows = await db.insert(moderationNotificationTable)
    .values({
      id: generateUuidV7(),
      accountId: account.id,
      type: "suspension_ending",
      actionId: action.id,
    })
    .onConflictDoNothing()
    .returning();
  return rows[0];
}
