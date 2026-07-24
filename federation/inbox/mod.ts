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
  Like,
  Move,
  QuoteRequest,
  Reject,
  Remove,
  Undo,
  Update,
} from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { builder } from "../builder.ts";
import { onActorMoved } from "./actor.ts";
import {
  onAccepted,
  onDeleted,
  onFollowReceived,
  onRejected,
} from "./dispatch.ts";
import { onFlagged } from "./flag.ts";
import { onBlocked, onUnblocked, onUnfollowed } from "./following.ts";
import { onQuoteRequestReceived } from "./quote.ts";
import {
  onPostCreated,
  onPostPinned,
  onPostShared,
  onPostUnpinned,
  onPostUnshared,
  onReactedOnPost,
  onReactionUndoneOnPost,
} from "./subscribe.ts";
import { onUnverifiedActivity } from "./unverified.ts";
import { onUpdated } from "./update.ts";

const logger = getLogger(["hackerspub", "federation", "inbox"]);

builder
  .setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox")
  .setSharedKeyDispatcher((ctx) => ({
    identifier: new URL(ctx.canonicalOrigin).hostname,
  }))
  .onUnverifiedActivity(onUnverifiedActivity)
  .on(Accept, onAccepted)
  .on(Reject, onRejected)
  .on(QuoteRequest, onQuoteRequestReceived)
  .on(Follow, onFollowReceived)
  .on(Undo, async (fedCtx, undo) => {
    const object = await undo.getObject({ ...fedCtx, suppressError: true });
    if (object instanceof Follow) await onUnfollowed(fedCtx, undo);
    if (await onPostUnshared(fedCtx, undo)) return;
    if (await onReactionUndoneOnPost(fedCtx, undo)) return;
    if (await onUnblocked(fedCtx, undo)) return;
    logger.warn("Unhandled Undo object: {undo}", { undo });
  })
  .on(Create, onPostCreated)
  .on(Announce, onPostShared)
  .on(Update, onUpdated)
  .on(Like, onReactedOnPost)
  .on(EmojiReact, onReactedOnPost)
  .on(Delete, onDeleted)
  .on(Move, onActorMoved)
  .on(Flag, onFlagged)
  .on(Block, onBlocked)
  .on(Add, onPostPinned)
  .on(Remove, onPostUnpinned);
