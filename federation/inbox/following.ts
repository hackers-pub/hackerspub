import {
  Accept,
  Block,
  Follow,
  type InboxContext,
  type Reject,
  type Undo,
} from "@fedify/fedify";
import type { ContextData } from "@hackerspub/models/context";
import { getLogger } from "@logtape/logtape";
import { and, eq, sql } from "drizzle-orm";
import { persistActor } from "../../models/actor.ts";
import { persistBlocking } from "../../models/blocking.ts";
import {
  acceptFollowing,
  updateFolloweesCount,
  updateFollowersCount,
} from "../../models/following.ts";
import {
  createFollowNotification,
  deleteFollowNotification,
} from "../../models/notification.ts";
import {
  actorTable,
  blockingTable,
  followingTable,
} from "../../models/schema.ts";
import { validateUuid } from "../../models/uuid.ts";

const logger = getLogger(["hackerspub", "federation", "inbox", "following"]);

export async function onFollowAccepted(
  fedCtx: InboxContext<ContextData>,
  accept: Accept,
): Promise<void> {
  const follow = await accept.getObject(fedCtx);
  if (!(follow instanceof Follow)) return;
  else if (follow.objectId == null) return;
  else if (accept.actorId?.href !== follow.objectId.href) return;
  const followActor = fedCtx.parseUri(follow.actorId);
  if (followActor?.type !== "actor") return;
  else if (!validateUuid(followActor.identifier)) return;
  const { db } = fedCtx.data;
  const follower = await db.query.accountTable.findFirst({
    with: { actor: true },
    where: { id: followActor.identifier },
  });
  if (follower == null) return;
  const followee = await db.query.actorTable.findFirst({
    where: { iri: follow.objectId.href },
  });
  if (followee == null) return;
  if (follow.id == null) await acceptFollowing(db, follower, followee);
  else await acceptFollowing(db, follow.id);
}

export async function onFollowRejected(
  fedCtx: InboxContext<ContextData>,
  reject: Reject,
): Promise<void> {
  const follow = await reject.getObject(fedCtx);
  if (reject.actorId == null) return;
  if (!(follow instanceof Follow) || follow.id == null) return;
  if (follow.objectId?.href !== reject.actorId?.href) return;
  const { db } = fedCtx.data;
  await db
    .delete(followingTable)
    .where(
      and(
        eq(followingTable.iri, follow.id.href),
        eq(
          followingTable.followeeId,
          db.select({ id: actorTable.id })
            .from(actorTable)
            .where(eq(actorTable.iri, reject.actorId.href)),
        ),
      ),
    );
}

export async function onFollowed(
  fedCtx: InboxContext<ContextData>,
  follow: Follow,
) {
  if (follow.id == null || follow.objectId == null) return;
  const followObject = fedCtx.parseUri(follow.objectId);
  if (followObject?.type !== "actor") return;
  else if (!validateUuid(followObject.identifier)) return;
  const { db, disk } = fedCtx.data;
  const followee = await db.query.accountTable.findFirst({
    with: { actor: true },
    where: { id: followObject.identifier },
  });
  if (followee == null) return;
  const followActor = await follow.getActor(fedCtx);
  if (followActor == null) return;
  const follower = await persistActor(db, disk, fedCtx, followActor, {
    ...fedCtx,
    outbox: false,
  });
  if (follower == null) return;
  const rows = await db.insert(followingTable).values({
    iri: follow.id.href,
    followerId: follower.id,
    followeeId: followee.actor.id,
    accepted: sql`CURRENT_TIMESTAMP`,
  }).onConflictDoNothing().returning();
  if (rows.length < 1) return;
  await updateFolloweesCount(db, follower.id, 1);
  await updateFollowersCount(db, followee.actor.id, 1);
  await createFollowNotification(db, followee.id, follower, rows[0].accepted);
  await fedCtx.sendActivity(
    { identifier: followee.id },
    followActor,
    new Accept({
      id: new URL(
        `#accept/${follower.id}/${+rows[0].accepted!}`,
        fedCtx.getActorUri(followee.id),
      ),
      actor: fedCtx.getActorUri(followee.id),
      object: follow,
    }),
    { excludeBaseUris: [new URL(fedCtx.origin)] },
  );
}

export async function onUnfollowed(
  fedCtx: InboxContext<ContextData>,
  undo: Undo,
) {
  const follow = await undo.getObject(fedCtx);
  if (!(follow instanceof Follow)) return;
  if (follow.id == null || follow.actorId?.href !== undo.actorId?.href) return;
  const actorObject = await undo.getActor(fedCtx);
  if (actorObject == null) return;
  const { db, disk } = fedCtx.data;
  const actor = await persistActor(db, disk, fedCtx, actorObject, {
    ...fedCtx,
    outbox: false,
  });
  if (actor == null) return;
  const rows = await db.delete(followingTable)
    .where(
      and(
        eq(followingTable.iri, follow.id.href),
        eq(followingTable.followerId, actor.id),
      ),
    ).returning();
  if (rows.length < 1) {
    logger.debug("No following found for unfollow: {follow}", { follow });
    return;
  }
  const [following] = rows;
  await updateFolloweesCount(db, following.followerId, 1);
  await updateFollowersCount(db, following.followeeId, 1);
  const followee = await db.query.actorTable.findFirst({
    where: { id: following.followeeId },
  });
  if (followee?.accountId != null) {
    await deleteFollowNotification(
      db,
      followee.accountId,
      actor,
    );
  }
}

export async function onBlocked(
  fedCtx: InboxContext<ContextData>,
  block: Block,
): Promise<void> {
  await persistBlocking(
    fedCtx.data.db,
    fedCtx.data.disk,
    fedCtx,
    block,
    fedCtx,
  );
}

export async function onUnblocked(
  fedCtx: InboxContext<ContextData>,
  undo: Undo,
): Promise<boolean> {
  if (undo.actorId == null) return false;
  const getterOpts = { ...fedCtx, suppressError: true };
  const block = await undo.getObject(getterOpts);
  if (!(block instanceof Block)) return false;
  if (block.id == null || block.actorId?.href !== undo.actorId.href) {
    return false;
  }
  const { db } = fedCtx.data;
  const rows = await db.delete(blockingTable)
    .where(
      and(
        eq(blockingTable.iri, block.id.href),
        eq(
          blockingTable.blockerId,
          db.select({ id: actorTable.id })
            .from(actorTable)
            .where(eq(actorTable.iri, undo.actorId.href)),
        ),
      ),
    )
    .returning();
  return rows.length > 0;
}
