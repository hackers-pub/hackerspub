import {
  type Delete,
  type InboxContext,
  isActor,
  type Move,
  type Update,
} from "@fedify/fedify";
import { persistActor } from "@hackerspub/models/actor";
import type { ContextData } from "@hackerspub/models/context";
import { follow } from "@hackerspub/models/following";
import { actorTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";

export async function onActorUpdated(
  fedCtx: InboxContext<ContextData>,
  update: Update,
): Promise<void> {
  const actor = await update.getObject(fedCtx);
  if (!isActor(actor) || update.actorId?.href !== actor.id?.href) return;
  await persistActor(fedCtx, actor, { ...fedCtx, outbox: false });
}

export async function onActorDeleted(
  fedCtx: InboxContext<ContextData>,
  del: Delete,
): Promise<boolean> {
  const actorId = del.actorId;
  if (actorId == null || del.objectId?.href !== actorId.href) return false;
  const deletedRows = await fedCtx.data.db.delete(actorTable)
    .where(eq(actorTable.iri, actorId.href))
    .returning();
  return deletedRows.length > 0;
}

export async function onActorMoved(
  fedCtx: InboxContext<ContextData>,
  move: Move,
): Promise<void> {
  const actorId = move.actorId;
  if (actorId == null) return;
  const object = await move.getObject({ ...fedCtx, suppressError: true });
  if (!isActor(object) || object.id?.href !== actorId.href) return;
  const target = await move.getTarget({ ...fedCtx, suppressError: true });
  if (
    !isActor(target) || target.aliasIds.every((a) => a.href !== object.id?.href)
  ) {
    return;
  }
  const oldActor = await persistActor(fedCtx, object, fedCtx);
  if (oldActor == null) return;
  const newActor = await persistActor(fedCtx, target, fedCtx);
  if (newActor == null) return;
  const { db } = fedCtx.data;
  await db.update(actorTable)
    .set({ successorId: newActor.id })
    .where(eq(actorTable.id, oldActor.id));
  const followers = await db.query.actorTable.findMany({
    where: {
      followees: { followeeId: oldActor.id },
      accountId: { isNotNull: true },
    },
    with: { account: true },
  });
  for (const follower of followers) {
    if (follower.account == null) continue;
    await follow(
      fedCtx,
      { ...follower.account, actor: follower },
      newActor,
    );
  }
}
