import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  like,
} from "drizzle-orm";
import { db } from "../db.ts";
import { accountTable, actorTable, followingTable } from "../models/schema.ts";
import { validateUuid } from "../models/uuid.ts";
import { federation } from "./federation.ts";

federation
  .setFollowersDispatcher(
    "/ap/actors/{identifier}/followers",
    async (_ctx, identifier, cursor, filter) => {
      if (cursor == null || !validateUuid(identifier)) return null;
      const account = await db.query.accountTable.findFirst({
        with: { actor: true },
        where: eq(accountTable.id, identifier),
      });
      if (account == null) return null;
      const followers = await db.query.followingTable.findMany({
        with: { follower: true },
        where: and(
          eq(followingTable.followeeId, account.actor.id),
          isNotNull(followingTable.accepted),
          filter == null ? undefined : inArray(
            followingTable.followerId,
            db.select({ id: actorTable.id }).from(actorTable).where(
              like(actorTable.iri, `${filter.origin}/%`),
            ),
          ),
          cursor.trim() === ""
            ? undefined
            : gt(followingTable.accepted, new Date(cursor.trim())),
        ),
        orderBy: desc(followingTable.accepted),
        limit: 100,
      });
      return {
        items: followers.map((follow) => ({
          id: new URL(follow.follower.iri),
          inboxId: new URL(follow.follower.inboxUrl),
          endpoints: follow.follower.sharedInboxUrl == null ? null : {
            sharedInbox: new URL(follow.follower.sharedInboxUrl),
          },
        })),
        next: followers.length < 100
          ? null
          : followers[99].accepted?.toISOString(),
      };
    },
  )
  .setFirstCursor((_ctx, _identifier) => "")
  .setCounter(async (_ctx, identifier, filter) => {
    if (!validateUuid(identifier)) return null;
    const [{ cnt }] = await db.select({ cnt: count() })
      .from(followingTable)
      .innerJoin(actorTable, eq(followingTable.followeeId, actorTable.id))
      .where(and(
        eq(actorTable.accountId, identifier),
        isNotNull(followingTable.accepted),
        filter == null ? undefined : inArray(
          followingTable.followerId,
          db.select({ id: actorTable.id }).from(actorTable).where(
            like(actorTable.iri, `${filter.origin}/%`),
          ),
        ),
      ));
    return cnt;
  });
