import { type InboxContext, isActor, type Update } from "@fedify/fedify";
import { db } from "../../db.ts";
import { persistActor } from "../../models/actor.ts";

export async function onActorUpdated(
  fedCtx: InboxContext<void>,
  update: Update,
): Promise<void> {
  const actor = await update.getObject(fedCtx);
  if (!isActor(actor) || update.actorId?.href !== actor.id?.href) return;
  await persistActor(db, fedCtx, actor, { ...fedCtx, outbox: false });
}
