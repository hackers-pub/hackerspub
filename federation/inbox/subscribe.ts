import {
  type Announce,
  type Create,
  type Delete,
  type InboxContext,
  Tombstone,
  type Undo,
  type Update,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { db } from "../../db.ts";
import {
  deletePersistedPost,
  deleteSharedPost,
  isPostObject,
  persistPost,
  persistSharedPost,
} from "../../models/post.ts";

const logger = getLogger(["hackerspub", "federation", "inbox", "subscribe"]);

export async function onPostCreated(
  fedCtx: InboxContext<void>,
  create: Create,
): Promise<void> {
  logger.debug("On post created: {create}", { create });
  if (create.objectId?.origin !== create.actorId?.origin) return;
  const object = await create.getObject(fedCtx);
  if (!isPostObject(object)) return;
  if (object.attributionId?.href !== create.actorId?.href) return;
  await persistPost(db, object, {
    replies: true,
    documentLoader: fedCtx.documentLoader,
    contextLoader: fedCtx.contextLoader,
  });
}

export async function onPostUpdated(
  fedCtx: InboxContext<void>,
  update: Update,
): Promise<void> {
  logger.debug("On post updated: {update}", { update });
  if (update.objectId?.origin !== update.actorId?.origin) return;
  const object = await update.getObject(fedCtx);
  if (!isPostObject(object)) return;
  if (object.attributionId?.href !== update.actorId?.href) return;
  await persistPost(db, object, {
    replies: true,
    documentLoader: fedCtx.documentLoader,
    contextLoader: fedCtx.contextLoader,
  });
}

export async function onPostDeleted(
  fedCtx: InboxContext<void>,
  del: Delete,
): Promise<void> {
  logger.debug("On post deleted: {delete}", { delete: del });
  if (del.objectId?.origin !== del.actorId?.origin) return;
  const object = await del.getObject(fedCtx);
  if (
    !(isPostObject(object) || object instanceof Tombstone) ||
    object.id == null || del.actorId == null
  ) {
    return;
  }
  await deletePersistedPost(db, object.id, del.actorId);
}

export async function onPostShared(
  fedCtx: InboxContext<void>,
  announce: Announce,
): Promise<void> {
  logger.debug("On post shared: {announce}", { announce });
  if (announce.id?.origin !== announce.actorId?.origin) return;
  const object = await announce.getObject(fedCtx);
  if (!isPostObject(object)) return;
  await persistSharedPost(db, announce, fedCtx);
}

export async function onPostUnshared(
  _fedCtx: InboxContext<void>,
  undo: Undo,
): Promise<void> {
  logger.debug("On post unshared: {undo}", { undo });
  if (undo.objectId == null || undo.actorId == null) return;
  if (undo.objectId?.origin !== undo.actorId?.origin) return;
  await deleteSharedPost(db, undo.objectId, undo.actorId);
}
