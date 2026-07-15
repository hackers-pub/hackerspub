import type { InboxContext } from "@fedify/fedify";
import {
  Accept,
  type Actor as ActivityPubActor,
  Block,
  Follow,
  type Reject,
  type Undo,
} from "@fedify/vocab";
import {
  isCachedActorFederationBlocked,
  persistActor,
} from "@hackerspub/models/actor";
import {
  persistPreparedBlocking,
  prepareBlocking,
} from "@hackerspub/models/blocking";
import type { ContextData } from "@hackerspub/models/context";
import {
  sendActivityWithOutbox,
  toApplicationContext,
  withInboxTransaction,
} from "../context.ts";
import {
  acceptFollowing,
  updateFolloweesCount,
  updateFollowersCount,
} from "@hackerspub/models/following";
import {
  createFollowNotification,
  deleteFollowNotification,
} from "@hackerspub/models/notification";
import {
  actorTable,
  blockingTable,
  followingTable,
} from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { getLogger } from "@logtape/logtape";
import { and, eq, sql } from "drizzle-orm";

const logger = getLogger(["hackerspub", "federation", "inbox", "following"]);

export interface FollowAcceptanceRepository {
  acceptByIri(followIri: string): Promise<boolean>;
  acceptByActorIds(
    followerActorId: Uuid,
    followeeActorId: Uuid,
  ): Promise<boolean>;
}

export interface FollowRejectionRepository {
  rejectByIri(followIri: string, followeeActorId: Uuid): Promise<boolean>;
  rejectByActorIds(
    followerActorId: Uuid,
    followeeActorId: Uuid,
  ): Promise<boolean>;
}

export interface PendingOutgoingFollowRepository {
  findPendingOutgoingByIri(
    followIri: string,
    followeeIri: string,
  ): Promise<
    {
      followIri: string;
      followerActorId: Uuid;
      followeeActorId: Uuid;
    } | undefined
  >;
}

export interface PreparedFollower {
  actor: ActivityPubActor;
  persisted: NonNullable<Awaited<ReturnType<typeof persistActor>>>;
}

async function findPendingOutgoingByIri(
  db: ContextData["db"],
  followIri: string,
  followeeIri: string,
): Promise<
  {
    followIri: string;
    followerActorId: Uuid;
    followeeActorId: Uuid;
  } | undefined
> {
  const pendingFollow = await db.query.followingTable.findFirst({
    columns: {
      iri: true,
      followerId: true,
      followeeId: true,
    },
    with: {
      followee: {
        columns: { iri: true },
      },
    },
    where: {
      iri: followIri,
      accepted: { isNull: true },
    },
  });
  return pendingFollow?.followee.iri === followeeIri
    ? {
      followIri: pendingFollow.iri,
      followerActorId: pendingFollow.followerId,
      followeeActorId: pendingFollow.followeeId,
    }
    : undefined;
}

export async function reconcileFollowAcceptance(
  repo: FollowAcceptanceRepository,
  values: {
    followIri: string | null;
    followerActorId: Uuid;
    followeeActorId: Uuid;
  },
): Promise<boolean> {
  if (
    values.followIri != null &&
    await repo.acceptByIri(values.followIri)
  ) {
    return true;
  }
  return await repo.acceptByActorIds(
    values.followerActorId,
    values.followeeActorId,
  );
}

export async function reconcileFollowAcceptanceFromObjectId(
  repo: FollowAcceptanceRepository & PendingOutgoingFollowRepository,
  values: {
    followIri: string | null;
    followeeIri: string | null;
  },
): Promise<boolean> {
  if (values.followIri == null || values.followeeIri == null) return false;
  const pendingFollow = await repo.findPendingOutgoingByIri(
    values.followIri,
    values.followeeIri,
  );
  if (pendingFollow == null) return false;
  return await reconcileFollowAcceptance(repo, pendingFollow);
}

export async function reconcileFollowRejection(
  repo: FollowRejectionRepository,
  values: {
    followIri: string | null;
    followerActorId: Uuid;
    followeeActorId: Uuid;
  },
): Promise<boolean> {
  if (
    values.followIri != null &&
    await repo.rejectByIri(values.followIri, values.followeeActorId)
  ) {
    return true;
  }
  return await repo.rejectByActorIds(
    values.followerActorId,
    values.followeeActorId,
  );
}

export async function reconcileFollowRejectionFromObjectId(
  repo: FollowRejectionRepository & PendingOutgoingFollowRepository,
  values: {
    followIri: string | null;
    followeeIri: string | null;
  },
): Promise<boolean> {
  if (values.followIri == null || values.followeeIri == null) return false;
  const pendingFollow = await repo.findPendingOutgoingByIri(
    values.followIri,
    values.followeeIri,
  );
  if (pendingFollow == null) return false;
  return await reconcileFollowRejection(repo, pendingFollow);
}

export async function onFollowAccepted(
  fedCtx: InboxContext<ContextData>,
  accept: Accept,
  resolved?: Readonly<{ object: unknown }>,
): Promise<boolean> {
  const { db } = fedCtx.data;
  const fallbackRepo = {
    async findPendingOutgoingByIri(followIri: string, followeeIri: string) {
      return await findPendingOutgoingByIri(db, followIri, followeeIri);
    },
    async acceptByIri(followIri: string) {
      return await acceptFollowing(db, followIri) != null;
    },
    async acceptByActorIds(followerActorId: Uuid, followeeActorId: Uuid) {
      const rows = await db.update(followingTable).set({
        accepted: sql`CURRENT_TIMESTAMP`,
      }).where(and(
        eq(followingTable.followerId, followerActorId),
        eq(followingTable.followeeId, followeeActorId),
        sql`${followingTable.accepted} IS NULL`,
      )).returning();
      if (rows.length > 0) {
        await updateFolloweesCount(db, rows[0].followerId, 1);
        await updateFollowersCount(db, rows[0].followeeId, 1);
      }
      return rows.length > 0;
    },
  };
  if (
    await reconcileFollowAcceptanceFromObjectId(
      fallbackRepo,
      {
        followIri: accept.objectId?.href ?? null,
        followeeIri: accept.actorId?.href ?? null,
      },
    )
  ) {
    return true;
  }
  const follow = resolved == null
    ? await accept.getObject({ ...fedCtx, crossOrigin: "trust" })
    : resolved.object;
  if (!(follow instanceof Follow)) return false;
  else if (follow.objectId == null) return false;
  else if (accept.actorId?.href !== follow.objectId.href) return false;
  const followActor = fedCtx.parseUri(follow.actorId);
  if (followActor?.type !== "actor") return false;
  else if (!validateUuid(followActor.identifier)) return false;
  const follower = await db.query.accountTable.findFirst({
    with: { actor: true },
    where: { id: followActor.identifier },
  });
  if (follower == null) return false;
  const followee = await db.query.actorTable.findFirst({
    where: { iri: follow.objectId.href },
  });
  if (followee == null) return false;
  return await reconcileFollowAcceptance(
    {
      async acceptByIri(followIri) {
        return await acceptFollowing(db, followIri) != null;
      },
      async acceptByActorIds(_followerActorId, _followeeActorId) {
        return await acceptFollowing(db, follower, followee) != null;
      },
    },
    {
      followIri: follow.id?.href ?? null,
      followerActorId: follower.actor.id,
      followeeActorId: followee.id,
    },
  );
}

export async function onFollowRejected(
  fedCtx: InboxContext<ContextData>,
  reject: Reject,
  resolved?: Readonly<{ object: unknown }>,
): Promise<boolean> {
  const { db } = fedCtx.data;
  const fallbackRepo = {
    async findPendingOutgoingByIri(followIri: string, followeeIri: string) {
      return await findPendingOutgoingByIri(db, followIri, followeeIri);
    },
    async rejectByIri(followIri: string, followeeActorId: Uuid) {
      const rows = await db
        .delete(followingTable)
        .where(
          and(
            eq(followingTable.iri, followIri),
            eq(followingTable.followeeId, followeeActorId),
          ),
        )
        .returning();
      return rows.length > 0;
    },
    async rejectByActorIds(followerActorId: Uuid, followeeActorId: Uuid) {
      const rows = await db
        .delete(followingTable)
        .where(
          and(
            eq(followingTable.followerId, followerActorId),
            eq(followingTable.followeeId, followeeActorId),
          ),
        )
        .returning();
      return rows.length > 0;
    },
  };
  if (
    await reconcileFollowRejectionFromObjectId(
      fallbackRepo,
      {
        followIri: reject.objectId?.href ?? null,
        followeeIri: reject.actorId?.href ?? null,
      },
    )
  ) {
    return true;
  }
  const follow = resolved == null
    ? await reject.getObject({ ...fedCtx, crossOrigin: "trust" })
    : resolved.object;
  if (reject.actorId == null) return false;
  if (!(follow instanceof Follow)) return false;
  if (follow.objectId?.href !== reject.actorId?.href) return false;
  const followee = await db.query.actorTable.findFirst({
    where: { iri: reject.actorId.href },
  });
  if (followee == null) return false;
  const followActor = fedCtx.parseUri(follow.actorId);
  if (followActor?.type !== "actor") return false;
  if (!validateUuid(followActor.identifier)) return false;
  const follower = await db.query.accountTable.findFirst({
    with: { actor: true },
    where: { id: followActor.identifier },
  });
  if (follower == null) return false;
  return await reconcileFollowRejection(
    {
      async rejectByIri(followIri, followeeActorId) {
        const rows = await db
          .delete(followingTable)
          .where(
            and(
              eq(followingTable.iri, followIri),
              eq(followingTable.followeeId, followeeActorId),
            ),
          )
          .returning();
        return rows.length > 0;
      },
      async rejectByActorIds(followerActorId, followeeActorId) {
        const rows = await db
          .delete(followingTable)
          .where(
            and(
              eq(followingTable.followerId, followerActorId),
              eq(followingTable.followeeId, followeeActorId),
            ),
          )
          .returning();
        return rows.length > 0;
      },
    },
    {
      followIri: follow.id?.href ?? null,
      followerActorId: follower.actor.id,
      followeeActorId: followee.id,
    },
  );
}

export async function onFollowed(
  fedCtx: InboxContext<ContextData>,
  follow: Follow,
  prepared?: PreparedFollower,
) {
  if (follow.id == null || follow.objectId == null) return;
  const followObject = fedCtx.parseUri(follow.objectId);
  if (followObject?.type !== "actor") return;
  else if (!validateUuid(followObject.identifier)) return;
  const { db } = fedCtx.data;
  const followee = await db.query.accountTable.findFirst({
    with: { actor: true },
    where: { id: followObject.identifier },
  });
  if (followee == null) return;
  const follower = prepared ?? await prepareFollower(fedCtx, follow);
  if (follower == null) return;
  const rows = await db.insert(followingTable).values({
    iri: follow.id.href,
    followerId: follower.persisted.id,
    followeeId: followee.actor.id,
    accepted: sql`CURRENT_TIMESTAMP`,
  }).onConflictDoNothing().returning();
  if (rows.length < 1) return;
  await updateFolloweesCount(db, follower.persisted.id, 1);
  await updateFollowersCount(db, followee.actor.id, 1);
  await createFollowNotification(
    db,
    followee.id,
    follower.persisted,
    rows[0].accepted,
  );
  await sendActivityWithOutbox(
    fedCtx,
    { identifier: followee.id },
    follower.actor,
    new Accept({
      id: new URL(
        `#accept/${follower.persisted.id}/${+rows[0].accepted!}`,
        fedCtx.getActorUri(followee.id),
      ),
      actor: fedCtx.getActorUri(followee.id),
      object: follow,
    }),
    {
      orderingKey: rows[0].iri,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
}

export async function prepareFollower(
  fedCtx: InboxContext<ContextData>,
  follow: Follow,
): Promise<PreparedFollower | undefined> {
  if (
    follow.id == null || follow.actorId == null || follow.objectId == null
  ) return undefined;
  const followObject = fedCtx.parseUri(follow.objectId);
  if (followObject?.type !== "actor") return undefined;
  if (!validateUuid(followObject.identifier)) return undefined;
  const { db } = fedCtx.data;
  const followee = await db.query.accountTable.findFirst({
    where: { id: followObject.identifier },
    columns: { id: true },
  });
  if (followee == null) return undefined;
  // Check the cached follower before fetching their actor document, so a
  // federation-blocked actor cannot make us spend the remote fetch.
  if (await isCachedActorFederationBlocked(db, follow.actorId)) {
    return undefined;
  }
  const followActor = await follow.getActor(fedCtx);
  if (followActor == null) return undefined;
  const follower = await persistActor(
    toApplicationContext(fedCtx),
    followActor,
    {
      ...fedCtx,
      outbox: false,
    },
  );
  return follower == null
    ? undefined
    : { actor: followActor, persisted: follower };
}

export async function onUnfollowed(
  fedCtx: InboxContext<ContextData>,
  undo: Undo,
) {
  const follow = await undo.getObject(fedCtx);
  if (!(follow instanceof Follow)) return;
  if (follow.id == null || follow.actorId?.href !== undo.actorId?.href) return;
  // Cleanup path: use the cached actor row instead of persistActor, so a
  // federation-blocked actor can still remove its own follow leftovers.
  if (undo.actorId == null) return;
  const { db } = fedCtx.data;
  const actor = await db.query.actorTable.findFirst({
    where: { iri: undo.actorId.href },
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
  const prepared = await prepareBlocking(
    toApplicationContext(fedCtx),
    block,
    fedCtx,
  );
  if (prepared == null) return;
  await withInboxTransaction(
    fedCtx,
    async (txCtx) =>
      await persistPreparedBlocking(toApplicationContext(txCtx), prepared),
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
