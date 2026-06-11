import type { Database } from "./db.ts";
import {
  type FlagCase,
  type ModerationNotification,
  moderationNotificationTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";

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
