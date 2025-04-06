import {
  Accept,
  Announce,
  Create,
  Delete,
  Follow,
  isActor,
  Undo,
  Update,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { captureException } from "@sentry/deno";
import { isPostObject } from "../../models/post.ts";
import { federation } from "../federation.ts";
import { onActorDeleted, onActorUpdated } from "./actor.ts";
import { onFollowAccepted, onFollowed, onUnfollowed } from "./following.ts";
import {
  onPostCreated,
  onPostDeleted,
  onPostShared,
  onPostUnshared,
  onPostUpdated,
} from "./subscribe.ts";

const logger = getLogger(["hackerspub", "federation", "inbox"]);

federation
  .setInboxListeners("/ap/actors/{identifier}/inbox", "/ap/inbox")
  .setSharedKeyDispatcher((ctx) => ({
    identifier: new URL(ctx.canonicalOrigin).hostname,
  }))
  .on(Accept, onFollowAccepted)
  .on(Follow, onFollowed)
  .on(Undo, async (fedCtx, undo) => {
    const object = await undo.getObject(fedCtx);
    if (object instanceof Follow) await onUnfollowed(fedCtx, undo);
    else await onPostUnshared(fedCtx, undo);
  })
  .on(Create, onPostCreated)
  .on(Announce, onPostShared)
  .on(Update, async (fedCtx, update) => {
    const object = await update.getObject(fedCtx);
    if (isActor(object)) await onActorUpdated(fedCtx, update);
    else if (isPostObject(object)) await onPostUpdated(fedCtx, update);
    else logger.warn("Unhandled Update object: {update}", { update });
  })
  .on(Delete, async (fedCtx, del) => {
    await onPostDeleted(fedCtx, del) ||
      await onActorDeleted(fedCtx, del) ||
      logger.warn("Unhandled Delete object: {delete}", { delete: del });
  })
  .onError((_, error) => void captureException(error));
