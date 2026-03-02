import type { Database } from "@hackerspub/models/db";
import {
  updateFolloweesCount,
  updateFollowersCount,
} from "@hackerspub/models/following";
import {
  type Actor,
  actorTable,
  type Following,
  followingTable,
} from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { and, inArray, isNull } from "drizzle-orm";
import { builder } from "./builder.ts";

const logger = getLogger(["hackerspub", "federation", "outbox"]);

/**
 * The set of database operations used by {@link handlePermanentFailure}.
 * Extracted as an interface so that tests can provide lightweight stubs
 * without needing a real database connection.
 */
export interface PermanentFailureRepository {
  findActorsByIris(iris: string[]): Promise<Actor[]>;
  deleteFollowingsByFollowerIds(followerIds: Uuid[]): Promise<Following[]>;
  deleteFollowingsByFolloweeIds(followeeIds: Uuid[]): Promise<Following[]>;
  updateFollowersCount(followeeId: Uuid, delta: number): Promise<void>;
  updateFolloweesCount(followerId: Uuid, delta: number): Promise<void>;
  deleteActors(actorIds: Uuid[]): Promise<void>;
}

/** Creates a {@link PermanentFailureRepository} backed by a real Drizzle DB. */
export function createRepository(db: Database): PermanentFailureRepository {
  return {
    async findActorsByIris(iris) {
      return await db.query.actorTable.findMany({
        where: { iri: { in: iris } },
      });
    },
    async deleteFollowingsByFollowerIds(followerIds) {
      return await db.delete(followingTable)
        .where(inArray(followingTable.followerId, followerIds))
        .returning();
    },
    async deleteFollowingsByFolloweeIds(followeeIds) {
      return await db.delete(followingTable)
        .where(inArray(followingTable.followeeId, followeeIds))
        .returning();
    },
    async updateFollowersCount(followeeId, delta) {
      await updateFollowersCount(db, followeeId, delta);
    },
    async updateFolloweesCount(followerId, delta) {
      await updateFolloweesCount(db, followerId, delta);
    },
    async deleteActors(actorIds) {
      await db.delete(actorTable)
        .where(
          and(
            inArray(actorTable.id, actorIds),
            isNull(actorTable.accountId),
          ),
        );
    },
  };
}

export interface PermanentFailureValues {
  readonly inbox: URL;
  readonly statusCode: number;
  readonly actorIds: readonly URL[];
}

/**
 * Handles permanent delivery failures by cleaning up following relationships
 * and optionally deleting actor records (on 410 Gone).
 *
 * Exported for testing purposes.
 */
export async function handlePermanentFailure(
  repo: PermanentFailureRepository,
  values: PermanentFailureValues,
): Promise<void> {
  const actorIris = values.actorIds.map((url) => url.href);
  if (actorIris.length < 1) return;

  // Find the remote actors matching the failed inbox's actor IRIs:
  const actors = await repo.findActorsByIris(actorIris);
  if (actors.length < 1) return;

  // Only process remote actors (accountId IS NULL); never touch local actors:
  const remoteActors = actors.filter((a) => a.accountId == null);
  if (remoteActors.length < 1) return;
  const remoteActorIds: Uuid[] = remoteActors.map((a) => a.id);

  logger.warn(
    "Permanent delivery failure to inbox {inbox} " +
      "(HTTP {statusCode}); cleaning up {actorCount} remote actor(s).",
    {
      inbox: values.inbox.href,
      statusCode: values.statusCode,
      actorCount: remoteActorIds.length,
    },
  );

  // Delete following relationships where the remote actor is a follower
  // (i.e., they follow a local user):
  const deletedAsFollower = await repo.deleteFollowingsByFollowerIds(
    remoteActorIds,
  );

  // Delete following relationships where the remote actor is a followee
  // (i.e., a local user follows them):
  const deletedAsFollowee = await repo.deleteFollowingsByFolloweeIds(
    remoteActorIds,
  );

  // Update follower counts for local users who lost these followers:
  for (const f of deletedAsFollower) {
    await repo.updateFollowersCount(f.followeeId, -1);
  }

  // Update followee counts for local users who lost these followees:
  for (const f of deletedAsFollowee) {
    await repo.updateFolloweesCount(f.followerId, -1);
  }

  // 410 Gone means the actor is explicitly gone forever — delete the actor
  // record entirely (cascading to their posts, reactions, votes, etc.):
  if (values.statusCode === 410) {
    await repo.deleteActors(remoteActorIds);
    logger.info(
      "Deleted {actorCount} remote actor record(s) due to 410 Gone " +
        "from inbox {inbox}.",
      {
        actorCount: remoteActorIds.length,
        inbox: values.inbox.href,
      },
    );
  }

  logger.info(
    "Cleaned up {followerRels} follower and {followeeRels} followee " +
      "relationship(s) due to permanent delivery failure (HTTP {statusCode}) " +
      "to inbox {inbox}.",
    {
      followerRels: deletedAsFollower.length,
      followeeRels: deletedAsFollowee.length,
      statusCode: values.statusCode,
      inbox: values.inbox.href,
    },
  );
}

builder.setOutboxPermanentFailureHandler(async (ctx, values) => {
  const repo = createRepository(ctx.data.db);
  await handlePermanentFailure(repo, values);
});
