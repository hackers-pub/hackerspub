import type { Database } from "./db.ts";
import {
  type FlagAction,
  type FlagAppeal,
  type FlagCase,
  type ModerationNotification,
  moderationNotificationTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

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
  const moderators = await db.query.accountTable.findMany({
    where: { moderator: true },
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
