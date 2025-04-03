import { getLogger } from "@logtape/logtape";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db.ts";
import {
  type Account,
  type Actor,
  type Instance,
  type Notification,
  notificationTable,
  type NotificationType,
  type Post,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "notification"]);

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
): Promise<Notification | undefined> {
  try {
    const postId = post?.id;
    const id = generateUuidV7();
    const notification = await db.insert(notificationTable)
      .values({
        id,
        accountId,
        type,
        postId,
        actorIds: [actorId],
        created: post?.published ?? sql`CURRENT_TIMESTAMP`,
      })
      .onConflictDoUpdate({
        target: [
          notificationTable.accountId,
          notificationTable.type,
          notificationTable.postId,
        ],
        set: {
          actorIds:
            sql`array_append(${notificationTable.actorIds}, ${actorId})`,
          created: post?.published ?? sql`CURRENT_TIMESTAMP`,
        },
      })
      .returning();
    return notification[0];
  } catch (error) {
    logger.error("Failed to create notification: {error}", { error });
    return undefined;
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
): Promise<Notification | undefined> {
  return createNotification(
    db,
    followeeAccountId,
    "follow",
    null,
    follower.id,
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
): Promise<Notification | undefined> {
  return createNotification(
    db,
    originalPostAuthorAccountId,
    "share",
    sharedPost,
    sharingActor.id,
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
  );
}

export async function deleteNotification(
  db: Database,
  accountId: Uuid,
  type: NotificationType,
  postId: Uuid | null,
  actorId: Uuid,
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
        ),
      )
      .returning();
    const deleted = await db.delete(notificationTable)
      .where(
        and(
          eq(notificationTable.accountId, accountId),
          eq(notificationTable.type, type),
          postId == null
            ? isNull(notificationTable.postId)
            : eq(notificationTable.postId, postId),
          eq(sql`array_length(${notificationTable.actorIds}, 1)`, 0),
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
