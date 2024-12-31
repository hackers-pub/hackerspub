import { type InboxContext, isActor, type Update } from "@fedify/fedify";
import { persistActor } from "../../models/actor.ts";
import { db } from "../../db.ts";

export async function onActorUpdated(
  fedCtx: InboxContext<void>,
  update: Update,
): Promise<void> {
  const actor = await update.getObject(fedCtx);
  if (!isActor(actor) || update.actorId?.href !== actor.id?.href) return;
  await persistActor(db, actor, { ...fedCtx, outbox: false });
}
