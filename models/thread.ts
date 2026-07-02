import { sql } from "drizzle-orm";
import type { Database, Transaction } from "./db.ts";
import type { Uuid } from "./uuid.ts";

/**
 * The hard bound on how many `reply_target_id` hops {@link getAncestorChain}
 * walks, so a pathological (or maliciously federated) chain cannot make the
 * recursive CTE run away.  Real chains observed in production top out around
 * a hundred hops.
 */
export const ANCESTOR_CHAIN_MAX_DEPTH = 200;

/**
 * The hard bound on how deep {@link getDescendantPage} descends below the
 * root post, regardless of the `maxDepth` the caller asks for.
 */
export const DESCENDANT_TREE_MAX_DEPTH = 40;

export interface AncestorChainEntry {
  /** The ancestor post's id. */
  id: Uuid;
  /** How many `reply_target_id` hops above the starting post (parent = 1). */
  depth: number;
}

/**
 * Walks the raw `reply_target_id` chain upward from the given post and
 * returns the ancestor post ids in nearest-first order (the direct parent is
 * the first entry, the thread root the last).  This is pure graph traversal:
 * no visibility, censorship, or sanction filtering is applied here — callers
 * must re-load the rows through the canonical post filters and decide how to
 * present chain gaps.
 *
 * Cycles (possible with hostile federation input) terminate: a hop into an
 * already-visited post stops the walk.  The walk is also bounded by `limit`
 * (default {@link ANCESTOR_CHAIN_MAX_DEPTH}); a result of exactly `limit`
 * entries may mean the chain continues further up.
 */
export async function getAncestorChain(
  db: Database | Transaction,
  postId: Uuid,
  options: { limit?: number } = {},
): Promise<AncestorChainEntry[]> {
  const limit = Math.min(
    options.limit ?? ANCESTOR_CHAIN_MAX_DEPTH,
    ANCESTOR_CHAIN_MAX_DEPTH,
  );
  if (limit < 1) return [];
  const rows = await db.execute<{ id: Uuid; depth: number }>(sql`
    with recursive ancestors as (
      select p.reply_target_id as id, 1 as depth, array[p.id] as seen
      from post p
      where p.id = ${postId} and p.reply_target_id <> p.id
      union all
      select p.reply_target_id, a.depth + 1, a.seen || p.id
      from post p
      join ancestors a on p.id = a.id
      where p.reply_target_id is not null
        and not (p.reply_target_id = any(a.seen))
        and a.depth < ${limit}
    )
    select id, depth from ancestors where id is not null order by depth
  `);
  return rows.map((row) => ({ id: row.id, depth: Number(row.depth) }));
}

export interface DescendantEntry {
  /** The descendant post's id. */
  id: Uuid;
  /** The id of the post this entry directly replies to. */
  parentId: Uuid;
  /** How many hops below the root post (direct replies = 1). */
  depth: number;
  /**
   * An opaque, strictly increasing pagination token for this entry within
   * the tree's depth-first order.  Feed it back as `options.after` to resume
   * the traversal right after this entry.
   */
  cursor: string;
}

export interface DescendantPage {
  /** The page of descendants, in depth-first order. */
  entries: DescendantEntry[];
  /** Whether more descendants follow the last entry of this page. */
  hasMore: boolean;
}

/**
 * Returns one page of the reply subtree below the given post, flattened in
 * depth-first order with siblings ordered by `published` (then by id, so the
 * order is total).  A parent always precedes its replies, including across
 * pages, so callers can rebuild the tree incrementally from `parentId`.
 *
 * Censored descendants are pruned inside the traversal *together with their
 * whole subtree* — except the viewer's own censored posts, mirroring
 * `getCensoredPostExclusionFilter`'s "author can still view their own
 * content" carve-out.  Other filtering (sanctions, per-post visibility) is
 * the caller's job: re-load the rows through the canonical filters and drop
 * entries whose `parentId` got dropped, so pruned subtrees never leak.
 *
 * Cycles terminate (a hop into a post already on the current path stops that
 * branch), and the traversal never descends more than
 * {@link DESCENDANT_TREE_MAX_DEPTH} levels no matter what `maxDepth` says.
 */
export async function getDescendantPage(
  db: Database | Transaction,
  postId: Uuid,
  options: {
    after?: string | null;
    limit: number;
    maxDepth: number;
    viewerActorId?: Uuid | null;
  },
): Promise<DescendantPage> {
  const maxDepth = Math.min(
    Math.max(options.maxDepth, 1),
    DESCENDANT_TREE_MAX_DEPTH,
  );
  const limit = Math.max(options.limit, 0);
  if (limit < 1) return { entries: [], hasMore: false };
  const viewerActorId = options.viewerActorId ?? null;
  // Each path element is fixed-width (18-digit zero-padded epoch
  // microseconds — the full precision of timestamptz — then `~` and the
  // 36-char uuid as a total-order tiebreak), so element-wise text[]
  // comparison yields the depth-first order with chronological siblings,
  // and a `path > $after` predicate resumes the traversal exactly.
  const pathElement = (alias: string) =>
    sql.raw(
      `lpad((extract(epoch from ${alias}.published) * 1000000)` +
        `::bigint::text, 18, '0') || '~' || ${alias}.id::text`,
    );
  const censoredPrune = (alias: string) =>
    viewerActorId == null
      ? sql.raw(`${alias}.censored is null`)
      : sql`(${sql.raw(alias)}.censored is null
          or ${sql.raw(alias)}.actor_id = ${viewerActorId})`;
  const afterPredicate = options.after == null
    ? sql.raw("true")
    : sql`t.path > string_to_array(${options.after}, '/')`;
  const rows = await db.execute<
    { id: Uuid; parent_id: Uuid; depth: number; cursor: string }
  >(sql`
    with recursive thread as (
      select p.id, p.reply_target_id as parent_id, 1 as depth,
        array[${pathElement("p")}] as path,
        array[p.id] as ids
      from post p
      where p.reply_target_id = ${postId}
        and p.id <> ${postId}
        and ${censoredPrune("p")}
      union all
      select c.id, c.reply_target_id, t.depth + 1,
        t.path || (${pathElement("c")}),
        t.ids || c.id
      from post c
      join thread t on c.reply_target_id = t.id
      where t.depth < ${maxDepth}
        and not (c.id = any(t.ids))
        and c.id <> ${postId}
        and ${censoredPrune("c")}
    )
    select t.id, t.parent_id, t.depth,
      array_to_string(t.path, '/') as cursor
    from thread t
    where ${afterPredicate}
    order by t.path
    limit ${limit + 1}
  `);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : [...rows];
  return {
    entries: page.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      depth: Number(row.depth),
      cursor: row.cursor,
    })),
    hasMore,
  };
}
