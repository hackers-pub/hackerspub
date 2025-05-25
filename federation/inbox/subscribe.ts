import {
  type Add,
  type Announce,
  type Create,
  type Delete,
  EmojiReact,
  type InboxContext,
  Like,
  type Remove,
  Tombstone,
  type Undo,
  type Update,
} from "@fedify/fedify";
import { getPersistedActor, persistActor } from "@hackerspub/models/actor";
import type { ContextData } from "@hackerspub/models/context";
import {
  createMentionNotification,
  createQuoteNotification,
  createReplyNotification,
  createShareNotification,
  deleteShareNotification,
} from "@hackerspub/models/notification";
import {
  deletePersistedPost,
  deleteSharedPost,
  isPostObject,
  persistPost,
  persistSharedPost,
} from "@hackerspub/models/post";
import {
  deleteReaction,
  persistReaction,
  updateReactionsCounts,
} from "@hackerspub/models/reaction";
import { pinTable, type Post, reactionTable } from "@hackerspub/models/schema";
import {
  addPostToTimeline,
  removeFromTimeline,
} from "@hackerspub/models/timeline";
import { getLogger } from "@logtape/logtape";
import { and, eq, or } from "drizzle-orm";

const logger = getLogger(["hackerspub", "federation", "inbox", "subscribe"]);

export async function onPostCreated(
  fedCtx: InboxContext<ContextData>,
  create: Create,
): Promise<void> {
  logger.debug("On post created: {create}", { create });
  if (create.objectId?.origin !== create.actorId?.origin) return;
  const object = await create.getObject({ ...fedCtx, suppressError: true });
  if (!isPostObject(object)) return;
  if (object.attributionId?.href !== create.actorId?.href) return;
  const { db } = fedCtx.data;
  const post = await persistPost(fedCtx, object, {
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
  fedCtx: InboxContext<ContextData>,
  update: Update,
): Promise<void> {
  logger.debug("On post updated: {update}", { update });
  if (update.objectId?.origin !== update.actorId?.origin) return;
  const object = await update.getObject({ ...fedCtx, suppressError: true });
  if (!isPostObject(object)) return;
  if (object.attributionId?.href !== update.actorId?.href) return;
  await persistPost(fedCtx, object, {
    replies: true,
    documentLoader: fedCtx.documentLoader,
    contextLoader: fedCtx.contextLoader,
  });
}

export async function onPostDeleted(
  fedCtx: InboxContext<ContextData>,
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
  return await deletePersistedPost(fedCtx.data.db, object.id, del.actorId);
}

export async function onPostShared(
  fedCtx: InboxContext<ContextData>,
  announce: Announce,
): Promise<void> {
  logger.debug("On post shared: {announce}", { announce });
  if (announce.id?.origin !== announce.actorId?.origin) return;
  const object = await announce.getObject({ ...fedCtx, suppressError: true });
  if (!isPostObject(object)) return;
  const post = await persistSharedPost(fedCtx, announce, fedCtx);
  if (post != null) {
    const { db } = fedCtx.data;
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
  fedCtx: InboxContext<ContextData>,
  undo: Undo,
): Promise<boolean> {
  logger.debug("On post unshared: {undo}", { undo });
  if (undo.objectId == null || undo.actorId == null) return false;
  if (undo.objectId?.origin !== undo.actorId?.origin) return false;
  const { db } = fedCtx.data;
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
  fedCtx: InboxContext<ContextData>,
  reaction: Like | EmojiReact,
): Promise<void> {
  logger.debug("On post reacted: {reaction}", { reaction });
  const reactionObject = await persistReaction(
    fedCtx,
    reaction,
    fedCtx,
  );
  if (reactionObject == null) return;
  await updateReactionsCounts(fedCtx.data.db, reactionObject.postId);
}

export async function onReactionUndoneOnPost(
  fedCtx: InboxContext<ContextData>,
  undo: Undo,
): Promise<boolean> {
  logger.debug("On reaction undone: {undo}", { undo });
  if (undo.objectId == null || undo.actorId == null) return false;
  if (undo.objectId?.origin !== undo.actorId?.origin) return false;
  const object = await undo.getObject({ ...fedCtx, suppressError: true });
  const { db } = fedCtx.data;
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

export async function onPostPinned(
  fedCtx: InboxContext<ContextData>,
  add: Add,
): Promise<void> {
  logger.debug("On post pinned: {add}", { add });
  if (add.actorId == null || add.targetId == null || add.objectId == null) {
    return;
  }
  let actor = await getPersistedActor(fedCtx.data.db, add.actorId);
  if (actor?.featuredUrl == null) {
    const actorObject = await add.getActor({ ...fedCtx, suppressError: true });
    if (actorObject == null) return;
    actor = await persistActor(fedCtx, actorObject, fedCtx);
    if (actor?.featuredUrl == null) return;
  }
  if (add.targetIds.find((tid) => tid.href === actor.featuredUrl) == null) {
    return;
  }
  const pinnedPosts: Post[] = [];
  for await (const obj of add.getObjects({ ...fedCtx, suppressError: true })) {
    if (!isPostObject(obj)) continue;
    const post = await persistPost(fedCtx, obj, fedCtx);
    if (post != null) pinnedPosts.push(post);
  }
  if (pinnedPosts.length > 0) {
    await fedCtx.data.db.insert(pinTable).values(
      pinnedPosts.map((post) => ({
        postId: post.id,
        actorId: actor.id,
      })),
    ).onConflictDoNothing();
  }
}

export async function onPostUnpinned(
  fedCtx: InboxContext<ContextData>,
  remove: Remove,
): Promise<void> {
  logger.debug("On post unpinned: {remove}", { remove });
  if (
    remove.actorId == null || remove.targetId == null || remove.objectId == null
  ) {
    return;
  }
  let actor = await getPersistedActor(fedCtx.data.db, remove.actorId);
  if (actor?.featuredUrl == null) {
    const actorObject = await remove.getActor({
      ...fedCtx,
      suppressError: true,
    });
    if (actorObject == null) return;
    actor = await persistActor(fedCtx, actorObject, fedCtx);
    if (actor?.featuredUrl == null) return;
  }
  if (remove.targetIds.find((tid) => tid.href === actor.featuredUrl) == null) {
    return;
  }
  const unpinnedPosts: Post[] = [];
  for await (
    const obj of remove.getObjects({ ...fedCtx, suppressError: true })
  ) {
    if (!isPostObject(obj)) continue;
    const post = await persistPost(fedCtx, obj, fedCtx);
    if (post != null) unpinnedPosts.push(post);
  }
  if (unpinnedPosts.length > 0) {
    await fedCtx.data.db.delete(pinTable).where(
      or(
        ...unpinnedPosts.map((post) =>
          and(
            eq(pinTable.postId, post.id),
            eq(pinTable.actorId, actor.id),
          )
        ),
      ),
    );
  }
}
