import { Announce, Create, InboxContext, Update } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import {
  isPostObject,
  persistPost,
  persistSharedPost,
} from "../../models/post.ts";
import { db } from "../../db.ts";

const logger = getLogger(["hackerspub", "federation", "inbox", "subscribe"]);

export async function onPostCreated(
  fedCtx: InboxContext<void>,
  create: Create,
): Promise<void> {
  logger.debug("On post created: {create}", { create });
  const object = await create.getObject(fedCtx);
  if (!isPostObject(object)) return;
  if (object.attributionId?.href !== create.actorId?.href) return;
  // TODO: visibility
  await persistPost(db, object, fedCtx);
}

// TODO: Delete(Article)

export async function onPostUpdated(
  fedCtx: InboxContext<void>,
  update: Update,
): Promise<void> {
  logger.debug("On post updated: {update}", { update });
  const object = await update.getObject(fedCtx);
  if (!isPostObject(object)) return;
  if (object.attributionId?.href !== update.actorId?.href) return;
  await persistPost(db, object, fedCtx);
}

export async function onPostShared(
  fedCtx: InboxContext<void>,
  announce: Announce,
): Promise<void> {
  logger.debug("On post shared: {announce}", { announce });
  const object = await announce.getObject(fedCtx);
  if (!isPostObject(object)) return;
  if (object.attributionId?.href !== announce.actorId?.href) return;
  await persistSharedPost(db, announce, fedCtx);
}

// TODO: Undo(Announce)
