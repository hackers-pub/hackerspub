import type { InboxContext } from "@fedify/fedify";
import { isActor, type Update } from "@fedify/vocab";
import { isCachedActorFederationBlocked } from "@hackerspub/models/actor";
import type { ContextData } from "@hackerspub/models/context";
import { isPostObject } from "@hackerspub/models/post/core";
import { getLogger } from "@logtape/logtape";
import { onActorUpdated } from "./actor.ts";
import { onPostUpdated } from "./subscribe.ts";

const logger = getLogger(["hackerspub", "federation", "inbox", "update"]);

export async function onUpdated(
  fedCtx: InboxContext<ContextData>,
  update: Update,
): Promise<void> {
  if (
    await isCachedActorFederationBlocked(fedCtx.data.db, update.actorId)
  ) {
    return;
  }
  let object: unknown;
  try {
    object = await update.getObject({ ...fedCtx, suppressError: true });
  } catch (error) {
    logger.debug(
      "Dropping Update activity {updateId}: failed to load object: {error}",
      { updateId: update.id?.href, error },
    );
    return;
  }
  if (isActor(object)) await onActorUpdated(fedCtx, update, object);
  else if (isPostObject(object)) await onPostUpdated(fedCtx, update, object);
  else logger.warn("Unhandled Update object: {update}", { update });
}
