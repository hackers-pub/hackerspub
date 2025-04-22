import {
  Accept,
  Announce,
  Block,
  Create,
  Delete,
  EmojiReact,
  Follow,
  isActor,
  Like,
  Move,
  Reject,
  Undo,
  Update,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { isPostObject } from "../../models/post.ts";
import { builder } from "../builder.ts";
import { onActorDeleted, onActorMoved, onActorUpdated } from "./actor.ts";
import {
  onBlocked,
  onFollowAccepted,
  onFollowed,
  onFollowRejected,
  onUnblocked,
  onUnfollowed,
} from "./following.ts";
import {
  onPostCreated,
  onPostDeleted,
  onPostShared,
  onPostUnshared,
  onPostUpdated,
  onReactedOnPost,
  onReactionUndoneOnPost,
} from "./subscribe.ts";

const logger = getLogger(["hackerspub", "federation", "inbox"]);

builder
  .setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox")
  .setSharedKeyDispatcher((ctx) => ({
    identifier: new URL(ctx.canonicalOrigin).hostname,
  }))
  .on(Accept, onFollowAccepted)
  .on(Reject, onFollowRejected)
  .on(Follow, onFollowed)
  .on(Undo, async (fedCtx, undo) => {
    const object = await undo.getObject({ ...fedCtx, suppressError: true });
    if (object instanceof Follow) await onUnfollowed(fedCtx, undo);
    await onPostUnshared(fedCtx, undo) ||
      await onReactionUndoneOnPost(fedCtx, undo) ||
      await onUnblocked(fedCtx, undo) ||
      logger.warn("Unhandled Undo object: {undo}", { undo });
  })
  .on(Create, onPostCreated)
  .on(Announce, onPostShared)
  .on(Update, async (fedCtx, update) => {
    const object = await update.getObject({ ...fedCtx, suppressError: true });
    if (isActor(object)) await onActorUpdated(fedCtx, update);
    else if (isPostObject(object)) await onPostUpdated(fedCtx, update);
    else logger.warn("Unhandled Update object: {update}", { update });
  })
  .on(Like, onReactedOnPost)
  .on(EmojiReact, onReactedOnPost)
  .on(Delete, async (fedCtx, del) => {
    await onPostDeleted(fedCtx, del) ||
      await onActorDeleted(fedCtx, del) ||
      logger.warn("Unhandled Delete object: {delete}", { delete: del });
  })
  .on(Move, onActorMoved)
  .on(Block, onBlocked);
