import type { InboxContext } from "@fedify/fedify";
import { type Delete, isActor, type Move, type Update } from "@fedify/vocab";
import {
  isCachedActorFederationBlocked,
  persistActor,
} from "@hackerspub/models/actor";
import type { ContextData } from "@hackerspub/models/context";
import { toApplicationContext } from "../context.ts";
import { follow } from "@hackerspub/models/following";
import {
  ActorSuspendedError,
  isActorSuspended,
} from "@hackerspub/models/moderation";
import { actorTable } from "@hackerspub/models/schema";
import { eq } from "drizzle-orm";

export async function onActorUpdated(
  fedCtx: InboxContext<ContextData>,
  update: Update,
  object?: unknown,
): Promise<void> {
  const actor =
    object ?? (await update.getObject({ ...fedCtx, suppressError: true }));
  if (!isActor(actor) || update.actorId?.href !== actor.id?.href) return;
  await persistActor(toApplicationContext(fedCtx), actor, {
    ...fedCtx,
    outbox: false,
  });
}

export async function onActorDeleted(
  fedCtx: InboxContext<ContextData>,
  del: Delete,
): Promise<boolean> {
  const actorId = del.actorId;
  if (actorId == null || del.objectId?.href !== actorId.href) return false;
  const { db } = fedCtx.data;
  const actor = await db.query.actorTable.findFirst({
    where: { iri: actorId.href },
    columns: { id: true, suspended: true, suspendedUntil: true },
  });
  if (actor == null) return false;
  // A Delete must not cascade-erase moderation records that the actor row is
  // referenced by.  Keep the row (recognizing the Delete without acting on
  // it) when:
  //   - the actor is under an active sanction (the row holds the
  //     suspension/ban);
  //   - it is the target of any moderation case, which holds the immutable
  //     flag_action audit (a standing warning/censor action, or an expired
  //     temporary suspension, leaves a case but no active suspension); or
  //   - it reported any flag, since flag.reporter_id cascades and would erase
  //     the report and its content_snapshot, letting an external reporter
  //     destroy pending moderation evidence with a Delete.
  // Otherwise the same IRI could re-federate without its federation block or
  // history, or pending evidence could vanish.
  if (isActorSuspended(actor)) return true;
  const moderationRefs = await Promise.all([
    db.query.flagCaseTable.findFirst({
      where: { targetActorId: actor.id },
      columns: { id: true },
    }),
    db.query.flagTable.findFirst({
      where: { reporterId: actor.id },
      columns: { id: true },
    }),
  ]);
  if (moderationRefs.some((row) => row != null)) return true;
  const deletedRows = await db
    .delete(actorTable)
    .where(eq(actorTable.id, actor.id))
    .returning();
  return deletedRows.length > 0;
}

export async function onActorMoved(
  fedCtx: InboxContext<ContextData>,
  move: Move,
): Promise<void> {
  const actorId = move.actorId;
  if (actorId == null) return;
  // Check the cached actor before dereferencing the Move's object and
  // target, so a federation-blocked actor cannot force remote fetches.
  if (await isCachedActorFederationBlocked(fedCtx.data.db, actorId)) {
    return;
  }
  const object = await move.getObject({ ...fedCtx, suppressError: true });
  if (!isActor(object) || object.id?.href !== actorId.href) return;
  const target = await move.getTarget({ ...fedCtx, suppressError: true });
  if (
    !isActor(target) ||
    target.aliasIds.every((a) => a.href !== object.id?.href)
  ) {
    return;
  }
  const oldActor = await persistActor(
    toApplicationContext(fedCtx),
    object,
    fedCtx,
  );
  if (oldActor == null) return;
  const newActor = await persistActor(
    toApplicationContext(fedCtx),
    target,
    fedCtx,
  );
  if (newActor == null) return;
  if (newActor.id === oldActor.id) return;
  const { db } = fedCtx.data;
  await db
    .update(actorTable)
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
    try {
      await follow(
        toApplicationContext(fedCtx),
        { ...follower.account, actor: follower },
        newActor,
      );
    } catch (error) {
      // A suspended follower simply does not re-follow the moved actor;
      // their other follows must still be migrated.
      if (!(error instanceof ActorSuspendedError)) throw error;
    }
  }
}
