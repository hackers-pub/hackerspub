import { getLogger } from "@logtape/logtape";
import { and, eq, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import { type ApnsNotificationOptions, sendApnsNotification } from "./apns.ts";
import type { Database } from "./db.ts";
import {
  type Account,
  type Actor,
  type CustomEmoji,
  type Instance,
  type Notification,
  notificationTable,
  type NotificationType,
  type Post,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "notification"]);

async function sendApnsNotificationBestEffort(
  db: Database,
  options: ApnsNotificationOptions,
): Promise<void> {
  try {
    await sendApnsNotification(db, options);
  } catch (error) {
    logger.error(
      "Failed to send APNS notification after persistence: {error}",
      { error },
    );
  }
}

/**
 * Creates a new notification record in the database.
 * @param db Database instance
 * @param accountId The ID of the account to notify
 * @param type The type of notification
 * @param post The post associated with this notification (null for 'follow' type)
 * @param actorIds Array of actor IDs that triggered this notification
 * @returns The created notification record or undefined if it couldn't be created
 */
export async function createNotification(
  db: Database,
  accountId: Uuid,
  type: NotificationType,
  post: Post | null,
  actorId: Uuid,
  created?: Date | null,
  emoji?: string | CustomEmoji | null,
): Promise<Notification | undefined> {
  const postId = post?.id;
  try {
    const id = generateUuidV7();
    const notificationRows = await db.insert(notificationTable)
      .values({
        id,
        accountId,
        type,
        postId,
        actorIds: [actorId],
        emoji: typeof emoji === "string" ? emoji : null,
        customEmojiId: typeof emoji === "string" || emoji == null
          ? null
          : emoji.id,
        created: created ?? sql`CURRENT_TIMESTAMP`,
      })
      .returning();
    const notification = notificationRows[0];
    if (notification != null) {
      await sendApnsNotificationBestEffort(db, {
        accountId,
        notificationId: notification.id,
        type,
        actorId,
        postId,
        emoji,
      });
    }
    return notification;
  } catch (error) {
    if (error instanceof postgres.PostgresError && error.code === "23505") {
      const notificationRows = await db.update(notificationTable)
        .set({
          actorIds:
            sql`array_append(${notificationTable.actorIds}, ${actorId})`,
          created: created ?? sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(notificationTable.accountId, accountId),
            eq(notificationTable.type, type),
            post == null
              ? isNull(notificationTable.postId)
              : eq(notificationTable.postId, post.id),
            emoji == null
              ? undefined
              : typeof emoji === "string"
              ? eq(notificationTable.emoji, emoji)
              : eq(notificationTable.customEmojiId, emoji.id),
          ),
        )
        .returning();
      const notification = notificationRows[0];
      if (notification != null) {
        await sendApnsNotificationBestEffort(db, {
          accountId,
          notificationId: notification.id,
          type,
          actorId,
          postId,
          emoji,
        });
      }
      return notification;
    } else {
      logger.error("Failed to create notification: {error}", { error });
      return undefined;
    }
  }
}

/**
 * Creates a follow notification when a user follows another user.
 * @param db Database instance
 * @param followeeAccountId The ID of the user being followed
 * @param follower The user who is following
 * @returns The created notification record or undefined if creation failed
 */
export function createFollowNotification(
  db: Database,
  followeeAccountId: Uuid,
  follower: Actor,
  created?: Date | null,
): Promise<Notification | undefined> {
  return createNotification(
    db,
    followeeAccountId,
    "follow",
    null,
    follower.id,
    created,
  );
}

/**
 * Creates a mention notification when a user is mentioned in a post.
 * @param db Database instance
 * @param mentionedAccountId The ID of the account that was mentioned
 * @param post The post where the mention occurred
 * @param mentioningActor The actor who mentioned the user
 * @returns The created notification record or undefined if creation failed
 */
export function createMentionNotification(
  db: Database,
  mentionedAccountId: Uuid,
  post: Post,
  mentioningActor: Actor,
): Promise<Notification | undefined> {
  return createNotification(
    db,
    mentionedAccountId,
    "mention",
    post,
    mentioningActor.id,
    post.published,
  );
}

/**
 * Creates a reply notification when a user replies to a post.
 * @param db Database instance
 * @param originalPostAuthorAccountId The ID of the account that authored the original post
 * @param replyPost The reply post
 * @param replyAuthor The actor who created the reply
 * @returns The created notification record or undefined if creation failed
 */
export function createReplyNotification(
  db: Database,
  originalPostAuthorAccountId: Uuid,
  replyPost: Post,
  replyAuthor: Actor,
): Promise<Notification | undefined> {
  return createNotification(
    db,
    originalPostAuthorAccountId,
    "reply",
    replyPost,
    replyAuthor.id,
    replyPost.published,
  );
}

/**
 * Creates a share notification when a user shares a post.
 * @param db Database instance
 * @param originalPostAuthorAccountId The ID of the account that authored the original post
 * @param sharedPost The shared post (the post that was shared)
 * @param sharingActor The actor who shared the post
 * @returns The created notification record or undefined if creation failed
 */
export function createShareNotification(
  db: Database,
  originalPostAuthorAccountId: Uuid,
  sharedPost: Post,
  sharingActor: Actor,
  created?: Date | null,
): Promise<Notification | undefined> {
  return createNotification(
    db,
    originalPostAuthorAccountId,
    "share",
    sharedPost,
    sharingActor.id,
    created,
  );
}

/**
 * Creates a quote notification when a user quotes a post.
 * @param db Database instance
 * @param originalPostAuthorAccountId The ID of the account that authored the original post
 * @param quotePost The quote post
 * @param quotingActor The actor who quoted the post
 * @returns The created notification record or undefined if creation failed
 */
export function createQuoteNotification(
  db: Database,
  originalPostAuthorAccountId: Uuid,
  quotePost: Post,
  quotingActor: Actor,
): Promise<Notification | undefined> {
  return createNotification(
    db,
    originalPostAuthorAccountId,
    "quote",
    quotePost,
    quotingActor.id,
    quotePost.published,
  );
}

export function createReactNotification(
  db: Database,
  postAuthorAccountId: Uuid,
  post: Post,
  reactingActor: Actor,
  emoji: string | CustomEmoji,
): Promise<Notification | undefined> {
  return createNotification(
    db,
    postAuthorAccountId,
    "react",
    post,
    reactingActor.id,
    null,
    emoji,
  );
}

export async function deleteNotification(
  db: Database,
  accountId: Uuid,
  type: NotificationType,
  postId: Uuid | null,
  actorId: Uuid,
  emoji?: string | CustomEmoji | null,
): Promise<Notification | undefined> {
  try {
    const updated = await db.update(notificationTable)
      .set({
        actorIds: sql`array_remove(${notificationTable.actorIds}, ${actorId})`,
      })
      .where(
        and(
          eq(notificationTable.accountId, accountId),
          eq(notificationTable.type, type),
          postId == null
            ? isNull(notificationTable.postId)
            : eq(notificationTable.postId, postId),
          emoji == null
            ? undefined
            : typeof emoji === "string"
            ? eq(notificationTable.emoji, emoji)
            : eq(notificationTable.customEmojiId, emoji.id),
        ),
      )
      .returning();
    const isActorIdsEmpty = isNull(
      sql`array_length(${notificationTable.actorIds}, 1)`,
    );
    const deleted = await db.delete(notificationTable)
      .where(
        and(
          eq(notificationTable.accountId, accountId),
          eq(notificationTable.type, type),
          postId == null
            ? isNull(notificationTable.postId)
            : eq(notificationTable.postId, postId),
          emoji == null
            ? undefined
            : typeof emoji === "string"
            ? eq(notificationTable.emoji, emoji)
            : eq(notificationTable.customEmojiId, emoji.id),
          isActorIdsEmpty,
        ),
      )
      .returning();
    return deleted.length > 0 ? deleted[0] : updated[0];
  } catch (error) {
    logger.error("Failed to delete notification: {error}", { error });
    return undefined;
  }
}

export function deleteFollowNotification(
  db: Database,
  followeeAccountId: Uuid,
  follower: Actor,
): Promise<Notification | undefined> {
  return deleteNotification(
    db,
    followeeAccountId,
    "follow",
    null,
    follower.id,
  );
}

export function deleteShareNotification(
  db: Database,
  originalPostAuthorAccountId: Uuid,
  sharedPost: Post,
  sharingActor: Actor,
): Promise<Notification | undefined> {
  return deleteNotification(
    db,
    originalPostAuthorAccountId,
    "share",
    sharedPost.id,
    sharingActor.id,
  );
}

export function deleteReactNotification(
  db: Database,
  postAuthorAccountId: Uuid,
  post: Post,
  reactingActor: Actor,
  emoji: string | CustomEmoji,
): Promise<Notification | undefined> {
  return deleteNotification(
    db,
    postAuthorAccountId,
    "react",
    post.id,
    reactingActor.id,
    emoji,
  );
}

/**
 * Gets all notifications for an account.
 * @param db Database instance
 * @param accountId The account ID to get notifications for
 * @param before Date to filter notifications before this time
 * @param limit Maximum number of notifications to return
 * @param offset Offset for pagination
 * @returns Array of notifications with their related posts and account information
 */
export function getNotifications(
  db: Database,
  accountId: Uuid,
  before: Date,
  limit = 20,
  offset = 0,
): Promise<
  (Notification & {
    post: Post & { actor: Actor & { instance: Instance } } | null;
    account: Account;
    customEmoji: CustomEmoji | null;
  })[]
> {
  return db.query.notificationTable.findMany({
    where: {
      accountId,
      created: { lte: before },
    },
    limit,
    offset,
    orderBy: (notification, { desc }) => [desc(notification.created)],
    with: {
      post: {
        with: {
          actor: {
            with: { instance: true },
          },
        },
      },
      account: true,
      customEmoji: true,
    },
  });
}

/**
 * Get notification actors (the users who triggered the notification)
 * Since we can't define a relation on an array field, we need to fetch them separately
 * @param db Database instance
 * @param actorIds Array of actor IDs
 * @returns Array of actors who triggered the notification
 */
export function getNotificationActors(
  db: Database,
  actorIds: Uuid[],
): Promise<Actor[]> {
  if (actorIds.length === 0) return Promise.resolve([]);

  return db.query.actorTable.findMany({
    where: { id: { in: actorIds } },
  });
}
