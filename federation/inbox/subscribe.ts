import {
  type Announce,
  type Create,
  type Delete,
  EmojiReact,
  type InboxContext,
  Like,
  Tombstone,
  type Undo,
  type Update,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { eq } from "drizzle-orm";
import { db } from "../../db.ts";
import {
  createMentionNotification,
  createQuoteNotification,
  createReplyNotification,
  createShareNotification,
  deleteShareNotification,
} from "../../models/notification.ts";
import {
  deletePersistedPost,
  deleteSharedPost,
  isPostObject,
  persistPost,
  persistSharedPost,
} from "../../models/post.ts";
import {
  deleteReaction,
  persistReaction,
  updateReactionsCounts,
} from "../../models/reaction.ts";
import { reactionTable } from "../../models/schema.ts";
import {
  addPostToTimeline,
  removeFromTimeline,
} from "../../models/timeline.ts";

const logger = getLogger(["hackerspub", "federation", "inbox", "subscribe"]);

export async function onPostCreated(
  fedCtx: InboxContext<void>,
  create: Create,
): Promise<void> {
  logger.debug("On post created: {create}", { create });
  if (create.objectId?.origin !== create.actorId?.origin) return;
  const object = await create.getObject({ ...fedCtx, suppressError: true });
  if (!isPostObject(object)) return;
  if (object.attributionId?.href !== create.actorId?.href) return;
  const post = await persistPost(db, fedCtx, object, {
    replies: true,
    documentLoader: fedCtx.documentLoader,
    contextLoader: fedCtx.contextLoader,
  });
  if (post != null) {
    await addPostToTimeline(db, post);
    if (post.replyTarget != null && post.replyTarget.actor.accountId != null) {
      await createReplyNotification(
        db,
        post.replyTarget.actor.accountId,
        post,
        post.actor,
      );
    }
    if (post.quotedPost != null && post.quotedPost.actor.accountId != null) {
      await createQuoteNotification(
        db,
        post.quotedPost.actor.accountId,
        post,
        post.actor,
      );
    }
    for (const mention of post.mentions) {
      if (mention.actor.accountId == null) continue;
      if (post.replyTarget?.actorId === mention.actorId) continue;
      if (post.quotedPost?.actorId === mention.actorId) continue;
      await createMentionNotification(
        db,
        mention.actor.accountId,
        post,
        post.actor,
      );
    }
  }
}

export async function onPostUpdated(
  fedCtx: InboxContext<void>,
  update: Update,
): Promise<void> {
  logger.debug("On post updated: {update}", { update });
  if (update.objectId?.origin !== update.actorId?.origin) return;
  const object = await update.getObject({ ...fedCtx, suppressError: true });
  if (!isPostObject(object)) return;
  if (object.attributionId?.href !== update.actorId?.href) return;
  await persistPost(db, fedCtx, object, {
    replies: true,
    documentLoader: fedCtx.documentLoader,
    contextLoader: fedCtx.contextLoader,
  });
}

export async function onPostDeleted(
  fedCtx: InboxContext<void>,
  del: Delete,
): Promise<boolean> {
  logger.debug("On post deleted: {delete}", { delete: del });
  if (del.objectId?.origin !== del.actorId?.origin) return false;
  const object = await del.getObject({ ...fedCtx, suppressError: true });
  if (
    !(isPostObject(object) || object instanceof Tombstone) ||
    object.id == null || del.actorId == null
  ) {
    return false;
  }
  return await deletePersistedPost(db, object.id, del.actorId);
}

export async function onPostShared(
  fedCtx: InboxContext<void>,
  announce: Announce,
): Promise<void> {
  logger.debug("On post shared: {announce}", { announce });
  if (announce.id?.origin !== announce.actorId?.origin) return;
  const object = await announce.getObject({ ...fedCtx, suppressError: true });
  if (!isPostObject(object)) return;
  const post = await persistSharedPost(db, fedCtx, announce, fedCtx);
  if (post != null) {
    await addPostToTimeline(db, post);
    if (post.sharedPost.actor.accountId != null) {
      await createShareNotification(
        db,
        post.sharedPost.actor.accountId,
        post.sharedPost,
        post.actor,
        post.published,
      );
    }
  }
}

export async function onPostUnshared(
  _fedCtx: InboxContext<void>,
  undo: Undo,
): Promise<boolean> {
  logger.debug("On post unshared: {undo}", { undo });
  if (undo.objectId == null || undo.actorId == null) return false;
  if (undo.objectId?.origin !== undo.actorId?.origin) return false;
  const post = await deleteSharedPost(db, undo.objectId, undo.actorId);
  if (post == null) return false;
  await removeFromTimeline(db, post);
  if (post.sharedPostId != null) {
    const sharedPost = await db.query.postTable.findFirst({
      where: { id: post.sharedPostId },
      with: { actor: true },
    });
    if (sharedPost?.actor.accountId != null) {
      await deleteShareNotification(
        db,
        sharedPost.actor.accountId,
        sharedPost,
        post.actor,
      );
    }
  }
  return true;
}

export async function onReactedOnPost(
  fedCtx: InboxContext<void>,
  reaction: Like | EmojiReact,
): Promise<void> {
  logger.debug("On post reacted: {reaction}", { reaction });
  const reactionObject = await persistReaction(db, fedCtx, reaction, fedCtx);
  if (reactionObject == null) return;
  await updateReactionsCounts(db, reactionObject.postId);
}

export async function onReactionUndoneOnPost(
  fedCtx: InboxContext<void>,
  undo: Undo,
): Promise<boolean> {
  logger.debug("On reaction undone: {undo}", { undo });
  if (undo.objectId == null || undo.actorId == null) return false;
  if (undo.objectId?.origin !== undo.actorId?.origin) return false;
  const object = await undo.getObject({ ...fedCtx, suppressError: true });
  if (object == null) {
    const rows = await db.delete(reactionTable)
      .where(eq(reactionTable.iri, undo.objectId.href))
      .returning();
    if (rows.length < 1) return false;
    await updateReactionsCounts(db, rows[0].postId);
    return true;
  } else if (object instanceof Like || object instanceof EmojiReact) {
    const reaction = await deleteReaction(db, object, fedCtx);
    if (reaction == null) return false;
    await updateReactionsCounts(db, reaction.postId);
    return true;
  }
  return false;
}
