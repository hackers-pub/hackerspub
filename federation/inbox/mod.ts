import {
  Accept,
  Add,
  Announce,
  Block,
  Create,
  Delete,
  EmojiReact,
  Flag,
  Follow,
  isActor,
  Like,
  Move,
  QuoteRequest,
  Reject,
  Remove,
  Undo,
  Update,
} from "@fedify/vocab";
import { isCachedActorFederationBlocked } from "@hackerspub/models/actor";
import { isPostObject } from "@hackerspub/models/post";
import { getLogger } from "@logtape/logtape";
import { builder } from "../builder.ts";
import { onActorDeleted, onActorMoved, onActorUpdated } from "./actor.ts";
import { onFlagged } from "./flag.ts";
import {
  onBlocked,
  onFollowAccepted,
  onFollowed,
  onFollowRejected,
  onUnblocked,
  onUnfollowed,
} from "./following.ts";
import {
  onQuoteAuthorizationDeleted,
  onQuoteRequestAccepted,
  onQuoteRequested,
  onQuoteRequestRejected,
} from "./quote.ts";
import { onRelayFollowAccepted, onRelayFollowRejected } from "./relay.ts";
import {
  onPostCreated,
  onPostDeleted,
  onPostPinned,
  onPostShared,
  onPostUnpinned,
  onPostUnshared,
  onPostUpdated,
  onReactedOnPost,
  onReactionUndoneOnPost,
} from "./subscribe.ts";
import { onUnverifiedActivity } from "./unverified.ts";

const logger = getLogger(["hackerspub", "federation", "inbox"]);

builder
  .setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox")
  .setSharedKeyDispatcher((ctx) => ({
    identifier: new URL(ctx.canonicalOrigin).hostname,
  }))
  .onUnverifiedActivity(onUnverifiedActivity)
  .on(Accept, async (fedCtx, accept) => {
    if (await onQuoteRequestAccepted(fedCtx, accept)) return;
    if (await onRelayFollowAccepted(fedCtx, accept)) return;
    await onFollowAccepted(fedCtx, accept);
  })
  .on(Reject, async (fedCtx, reject) => {
    if (await onQuoteRequestRejected(fedCtx, reject)) return;
    if (await onRelayFollowRejected(fedCtx, reject)) return;
    await onFollowRejected(fedCtx, reject);
  })
  .on(QuoteRequest, onQuoteRequested)
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
    if (
      await isCachedActorFederationBlocked(fedCtx.data.db, update.actorId)
    ) {
      return;
    }
    const object = await update.getObject({ ...fedCtx, suppressError: true });
    if (isActor(object)) await onActorUpdated(fedCtx, update);
    else if (isPostObject(object)) await onPostUpdated(fedCtx, update);
    else logger.warn("Unhandled Update object: {update}", { update });
  })
  .on(Like, onReactedOnPost)
  .on(EmojiReact, onReactedOnPost)
  .on(Delete, async (fedCtx, del) => {
    await onQuoteAuthorizationDeleted(fedCtx, del) ||
      await onPostDeleted(fedCtx, del) ||
      await onActorDeleted(fedCtx, del) ||
      logger.warn("Unhandled Delete object: {delete}", { delete: del });
  })
  .on(Move, onActorMoved)
  .on(Flag, onFlagged)
  .on(Block, onBlocked)
  .on(Add, onPostPinned)
  .on(Remove, onPostUnpinned);
