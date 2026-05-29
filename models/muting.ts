import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "./db.ts";
import {
  type Account,
  type Actor,
  type Muting,
  mutingTable,
} from "./schema.ts";
import { pruneMutedActorFromTimeline } from "./timeline.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

/**
 * Mutes an actor on behalf of a local account.  Muting is a purely local,
 * one-directional relationship: it is never federated and does not touch
 * follow relationships.  Idempotent: muting an already-muted actor returns the
 * existing record.
 */
export async function mute(
  db: Database,
  muter: Account & { actor: Actor },
  mutee: Actor,
): Promise<Muting | undefined> {
  const rows = await db.insert(mutingTable)
    .values({
      id: generateUuidV7(),
      muterId: muter.actor.id,
      muteeId: mutee.id,
    })
    .onConflictDoNothing()
    .returning();
  if (rows.length < 1) {
    return await db.query.mutingTable.findFirst({
      where: {
        muterId: muter.actor.id,
        muteeId: mutee.id,
      },
    });
  }
  // Clean the muted actor's already-propagated boosts out of the muter's feed.
  // (Future boosts are kept out by addPostToTimeline.)
  await pruneMutedActorFromTimeline(db, muter.id, muter.actor.id, mutee.id);
  return rows[0];
}

/**
 * Removes a mute previously created by {@link mute}.  Returns the deleted
 * record, or `undefined` if no such mute existed.
 */
export async function unmute(
  db: Database,
  muter: Account & { actor: Actor },
  mutee: Actor,
): Promise<Muting | undefined> {
  const rows = await db.delete(mutingTable).where(
    and(
      eq(mutingTable.muterId, muter.actor.id),
      eq(mutingTable.muteeId, mutee.id),
    ),
  ).returning();
  if (rows.length < 1) return undefined;
  return rows[0];
}

/**
 * Returns the subset of `muteeIds` that the given muter currently mutes.
 * Intended for batch (DataLoader) lookups.
 */
export async function getMutedActorIds(
  db: Database,
  muterId: Uuid,
  muteeIds: readonly Uuid[],
): Promise<Set<Uuid>> {
  if (muteeIds.length < 1) return new Set();
  const rows = await db
    .select({ muteeId: mutingTable.muteeId })
    .from(mutingTable)
    .where(
      and(
        eq(mutingTable.muterId, muterId),
        inArray(mutingTable.muteeId, muteeIds as Uuid[]),
      ),
    );
  return new Set(rows.map((row) => row.muteeId));
}
