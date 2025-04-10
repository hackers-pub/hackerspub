import {
  Accept,
  Follow,
  type InboxContext,
  type Reject,
  type Undo,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { persistActor } from "../../models/actor.ts";
import {
  acceptFollowing,
  updateFolloweesCount,
  updateFollowersCount,
} from "../../models/following.ts";
import {
  createFollowNotification,
  deleteFollowNotification,
} from "../../models/notification.ts";
import { actorTable, followingTable } from "../../models/schema.ts";
import { validateUuid } from "../../models/uuid.ts";

const logger = getLogger(["hackerspub", "federation", "inbox", "following"]);

export async function onFollowAccepted(
  fedCtx: InboxContext<void>,
  accept: Accept,
): Promise<void> {
  const follow = await accept.getObject(fedCtx);
  if (!(follow instanceof Follow)) return;
  else if (follow.objectId == null) return;
  else if (accept.actorId?.href !== follow.objectId.href) return;
  const followActor = fedCtx.parseUri(follow.actorId);
  if (followActor?.type !== "actor") return;
  else if (!validateUuid(followActor.identifier)) return;
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
  fedCtx: InboxContext<void>,
  reject: Reject,
): Promise<void> {
  const follow = await reject.getObject(fedCtx);
  if (reject.actorId == null) return;
  if (!(follow instanceof Follow) || follow.id == null) return;
  if (follow.objectId?.href !== reject.actorId?.href) return;
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
  fedCtx: InboxContext<void>,
  follow: Follow,
) {
  if (follow.id == null || follow.objectId == null) return;
  const followObject = fedCtx.parseUri(follow.objectId);
  if (followObject?.type !== "actor") return;
  else if (!validateUuid(followObject.identifier)) return;
  const followee = await db.query.accountTable.findFirst({
    with: { actor: true },
    where: { id: followObject.identifier },
  });
  if (followee == null) return;
  const followActor = await follow.getActor(fedCtx);
  if (followActor == null) return;
  const follower = await persistActor(db, fedCtx, followActor, {
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
  fedCtx: InboxContext<void>,
  undo: Undo,
) {
  const follow = await undo.getObject(fedCtx);
  if (!(follow instanceof Follow)) return;
  if (follow.id == null || follow.actorId?.href !== undo.actorId?.href) return;
  const actorObject = await undo.getActor(fedCtx);
  if (actorObject == null) return;
  const actor = await persistActor(db, fedCtx, actorObject, {
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
