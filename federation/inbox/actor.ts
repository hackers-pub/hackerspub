import {
  type Delete,
  type InboxContext,
  isActor,
  type Update,
} from "@fedify/fedify";
import { eq } from "drizzle-orm";
import { db } from "../../db.ts";
import { persistActor } from "../../models/actor.ts";
import { actorTable } from "../../models/schema.ts";

export async function onActorUpdated(
  fedCtx: InboxContext<void>,
  update: Update,
): Promise<void> {
  const actor = await update.getObject(fedCtx);
  if (!isActor(actor) || update.actorId?.href !== actor.id?.href) return;
  await persistActor(db, fedCtx, actor, { ...fedCtx, outbox: false });
}

export async function onActorDeleted(
  _fedCtx: InboxContext<void>,
  del: Delete,
): Promise<void> {
  const actorId = del.actorId;
  if (actorId == null || del.objectId?.href !== actorId.href) return;
  await db.delete(actorTable).where(eq(actorTable.iri, actorId.href));
}
