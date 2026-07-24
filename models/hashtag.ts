import { and, count, eq } from "drizzle-orm";
import type { Database } from "./db.ts";
import { type HashtagFollowing, hashtagFollowingTable } from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export function normalizeHashtag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

export function validateHashtag(tag: string): boolean {
  const normalized = normalizeHashtag(tag);
  return normalized.length > 0 && normalized.length <= 100;
}

export async function followHashtag(
  db: Database,
  accountId: Uuid,
  tag: string,
): Promise<HashtagFollowing> {
  const normalized = normalizeHashtag(tag);
  const [row] = await db
    .insert(hashtagFollowingTable)
    .values({ accountId, tag: normalized })
    .onConflictDoUpdate({
      target: [hashtagFollowingTable.accountId, hashtagFollowingTable.tag],
      set: { tag: normalized },
    })
    .returning();
  return row;
}

export async function unfollowHashtag(
  db: Database,
  accountId: Uuid,
  tag: string,
): Promise<void> {
  await db
    .delete(hashtagFollowingTable)
    .where(
      and(
        eq(hashtagFollowingTable.accountId, accountId),
        eq(hashtagFollowingTable.tag, normalizeHashtag(tag)),
      ),
    );
}

export async function pinHashtag(
  db: Database,
  accountId: Uuid,
  tag: string,
): Promise<boolean> {
  const rows = await db
    .update(hashtagFollowingTable)
    .set({ pinned: true })
    .where(
      and(
        eq(hashtagFollowingTable.accountId, accountId),
        eq(hashtagFollowingTable.tag, normalizeHashtag(tag)),
      ),
    )
    .returning({ accountId: hashtagFollowingTable.accountId });
  return rows.length > 0;
}

export async function unpinHashtag(
  db: Database,
  accountId: Uuid,
  tag: string,
): Promise<void> {
  await db
    .update(hashtagFollowingTable)
    .set({ pinned: false })
    .where(
      and(
        eq(hashtagFollowingTable.accountId, accountId),
        eq(hashtagFollowingTable.tag, normalizeHashtag(tag)),
      ),
    );
}

export async function isFollowingHashtag(
  db: Database,
  accountId: Uuid,
  tag: string,
): Promise<boolean> {
  const row = await db.query.hashtagFollowingTable.findFirst({
    columns: { accountId: true },
    where: { accountId, tag: normalizeHashtag(tag) },
  });
  return row != null;
}

export async function getPinnedHashtags(
  db: Database,
  accountId: Uuid,
): Promise<string[]> {
  const rows = await db.query.hashtagFollowingTable.findMany({
    columns: { tag: true },
    where: { accountId, pinned: true },
    orderBy: (t, { asc }) => [asc(t.created), asc(t.tag)],
  });
  return rows.map((r) => r.tag);
}

export async function getHashtagFollowerCount(
  db: Database,
  tag: string,
): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(hashtagFollowingTable)
    .where(eq(hashtagFollowingTable.tag, normalizeHashtag(tag)));
  return rows[0]?.count ?? 0;
}

export async function getFollowedHashtagNames(
  db: Database,
  accountId: Uuid,
): Promise<string[]> {
  const rows = await db.query.hashtagFollowingTable.findMany({
    columns: { tag: true },
    where: { accountId },
    orderBy: (t, { asc }) => [asc(t.tag)],
  });
  return rows.map((r) => r.tag);
}
