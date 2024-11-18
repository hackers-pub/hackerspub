import { type Context, Follow, Undo } from "@fedify/fedify";
import { and, eq, sql } from "drizzle-orm";
import {
  type Account,
  type Actor,
  type Following,
  followingTable,
} from "./schema.ts";
import { Database } from "../db.ts";

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
      {
        id: new URL(followee.iri),
        inboxId: new URL(followee.inboxUrl),
        endpoints: followee.sharedInboxUrl == null
          ? null
          : { sharedInbox: new URL(followee.sharedInboxUrl) },
      },
      new Follow({
        id: new URL(rows[0].iri),
        actor: fedCtx.getActorUri(follower.id),
        object: new URL(followee.iri),
      }),
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
  if (typeof iriOrFollower === "string" || iriOrFollower instanceof URL) {
    const iri = iriOrFollower.toString();
    const rows = await db.update(followingTable).set({
      accepted: sql`CURRENT_TIMESTAMP`,
    }).where(
      eq(followingTable.iri, iri),
    ).returning();
    return rows[0];
  } else if (followee == null) return undefined;
  const follower = iriOrFollower;
  const rows = await db.update(followingTable).set({
    accepted: sql`CURRENT_TIMESTAMP`,
  }).where(
    and(
      eq(followingTable.followerId, follower.actor.id),
      eq(followingTable.followeeId, followee.id),
    ),
  ).returning();
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
      {
        id: new URL(followee.iri),
        inboxId: new URL(followee.inboxUrl),
        endpoints: followee.sharedInboxUrl == null
          ? null
          : { sharedInbox: new URL(followee.sharedInboxUrl) },
      },
      new Undo({
        actor: fedCtx.getActorUri(follower.id),
        object: new Follow({
          id: new URL(rows[0].iri),
          actor: fedCtx.getActorUri(follower.id),
          object: new URL(followee.iri),
        }),
      }),
    );
  }
  return rows[0];
}

export type FollowingState = "following" | "sentRequest" | "none";

export async function getFollowingState(
  db: Database,
  follower: Actor,
  followee: Actor,
): Promise<FollowingState> {
  const row = await db.query.followingTable.findFirst({
    where: and(
      eq(followingTable.followerId, follower.id),
      eq(followingTable.followeeId, followee.id),
    ),
  });
  return row == null
    ? "none"
    : row.accepted == null
    ? "sentRequest"
    : "following";
}
