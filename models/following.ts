import { type Context, Follow, Reject, Undo } from "@fedify/fedify";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db.ts";
import { toRecipient } from "./actor.ts";
import {
  createFollowNotification,
  deleteFollowNotification,
} from "./notification.ts";
import {
  type Account,
  type Actor,
  actorTable,
  type Following,
  followingTable,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export function createFollowingIri(
  fedCtx: Context<void>,
  follower: Account,
): URL {
  return new URL(
    `#follow/${crypto.randomUUID()}`,
    fedCtx.getActorUri(follower.id),
  );
}

export async function follow(
  db: Database,
  fedCtx: Context<void>,
  follower: Account & { actor: Actor },
  followee: Actor,
): Promise<Following | undefined> {
  const rows = await db.insert(followingTable).values({
    iri: createFollowingIri(fedCtx, follower).href,
    followerId: follower.actor.id,
    followeeId: followee.id,
    accepted: followee.accountId == null ? null : sql`CURRENT_TIMESTAMP`,
  }).onConflictDoNothing().returning();
  if (rows.length > 0 && followee.accountId == null) {
    await fedCtx.sendActivity(
      { identifier: follower.id },
      toRecipient(followee),
      new Follow({
        id: new URL(rows[0].iri),
        actor: fedCtx.getActorUri(follower.id),
        object: new URL(followee.iri),
      }),
      { excludeBaseUris: [new URL(fedCtx.origin)] },
    );
  } else if (rows.length > 0 && followee.accountId != null) {
    await updateFolloweesCount(db, rows[0].followerId, 1);
    await updateFollowersCount(db, rows[0].followeeId, 1);
    await createFollowNotification(
      db,
      followee.accountId,
      follower.actor,
      rows[0].accepted,
    );
  }
  return rows[0];
}

export async function acceptFollowing(
  db: Database,
  iri: string | URL,
): Promise<Following | undefined>;
export async function acceptFollowing(
  db: Database,
  follower: Account & { actor: Actor },
  followee: Actor,
): Promise<Following | undefined>;
export async function acceptFollowing(
  db: Database,
  iriOrFollower: string | URL | Account & { actor: Actor },
  followee?: Actor,
): Promise<Following | undefined> {
  let rows: Following[];
  if (typeof iriOrFollower === "string" || iriOrFollower instanceof URL) {
    const iri = iriOrFollower.toString();
    rows = await db.update(followingTable).set({
      accepted: sql`CURRENT_TIMESTAMP`,
    }).where(and(
      eq(followingTable.iri, iri),
      isNull(followingTable.accepted),
    )).returning();
  } else if (followee == null) {
    return undefined;
  } else {
    const follower = iriOrFollower;
    rows = await db.update(followingTable).set({
      accepted: sql`CURRENT_TIMESTAMP`,
    }).where(
      and(
        eq(followingTable.followerId, follower.actor.id),
        eq(followingTable.followeeId, followee.id),
        isNull(followingTable.accepted),
      ),
    ).returning();
  }
  if (rows.length > 0) {
    await updateFolloweesCount(db, rows[0].followerId, 1);
    await updateFollowersCount(db, rows[0].followeeId, 1);
  }
  return rows[0];
}

export async function unfollow(
  db: Database,
  fedCtx: Context<void>,
  follower: Account & { actor: Actor },
  followee: Actor,
): Promise<Following | undefined> {
  const rows = await db.delete(followingTable).where(
    and(
      eq(followingTable.followerId, follower.actor.id),
      eq(followingTable.followeeId, followee.id),
    ),
  ).returning();
  if (rows.length > 0 && followee.accountId == null) {
    await fedCtx.sendActivity(
      { identifier: follower.id },
      toRecipient(followee),
      new Undo({
        actor: fedCtx.getActorUri(follower.id),
        object: new Follow({
          id: new URL(rows[0].iri),
          actor: fedCtx.getActorUri(follower.id),
          object: new URL(followee.iri),
        }),
      }),
      { excludeBaseUris: [new URL(fedCtx.origin)] },
    );
  }
  if (rows.length > 0) {
    await updateFolloweesCount(db, rows[0].followerId, -1);
    await updateFollowersCount(db, rows[0].followeeId, -1);
    if (followee.accountId != null) {
      await deleteFollowNotification(
        db,
        followee.accountId,
        follower.actor,
      );
    }
  }
  return rows[0];
}

export async function removeFollower(
  db: Database,
  fedCtx: Context<void>,
  followee: Account & { actor: Actor },
  follower: Actor,
): Promise<Following | undefined> {
  const rows = await db.delete(followingTable).where(
    and(
      eq(followingTable.followerId, follower.id),
      eq(followingTable.followeeId, followee.actor.id),
    ),
  ).returning();
  if (rows.length < 1) return undefined;
  await updateFolloweesCount(db, rows[0].followerId, -1);
  await updateFollowersCount(db, rows[0].followeeId, -1);
  await deleteFollowNotification(db, followee.id, follower);
  if (follower.accountId == null) {
    await fedCtx.sendActivity(
      { identifier: followee.id },
      toRecipient(follower),
      new Reject({
        id: new URL(
          `/#reject/${followee.id}/${follower.id}/${rows[0].iri}`,
          fedCtx.getActorUri(followee.id),
        ),
        actor: fedCtx.getActorUri(followee.id),
        object: new Follow({
          id: new URL(rows[0].iri),
          actor: new URL(follower.iri),
          object: fedCtx.getActorUri(followee.id),
        }),
      }),
    );
  }
  return rows[0];
}

export async function updateFolloweesCount(
  db: Database,
  followerId: Uuid,
  delta: number,
): Promise<Actor | undefined> {
  const rows = await db.update(actorTable).set({
    followeesCount: sql`
      CASE WHEN ${actorTable.accountId} IS NULL
        THEN ${actorTable.followeesCount} + ${delta}
        ELSE (
          SELECT count(*)
          FROM ${followingTable}
          WHERE ${followingTable.followerId} = ${followerId}
            AND ${followingTable.accepted} IS NOT NULL
        )
      END
    `,
  }).where(eq(actorTable.id, followerId)).returning();
  return rows[0];
}

export async function updateFollowersCount(
  db: Database,
  followeeId: Uuid,
  delta: number,
): Promise<Actor | undefined> {
  const rows = await db.update(actorTable).set({
    followersCount: sql`
      CASE WHEN ${actorTable.accountId} IS NULL
        THEN ${actorTable.followersCount} + ${delta}
        ELSE (
          SELECT count(*)
          FROM ${followingTable}
          WHERE ${followingTable.followeeId} = ${followeeId}
            AND ${followingTable.accepted} IS NOT NULL
        )
      END
    `,
  }).where(eq(actorTable.id, followeeId)).returning();
  return rows[0];
}
