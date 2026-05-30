import { getLogger } from "@logtape/logtape";
import {
  and,
  count,
  desc,
  eq,
  isNotNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database, Transaction } from "./db.ts";
import { type PostLink, postLinkTable } from "./schema.ts";
import type { Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "news"]);

// ---------------------------------------------------------------------------
// Scoring constants
//
// A link's rank is a Reddit/Hacker-News-style additive-log score, recomputed
// in an idempotent batch.  These are deliberately plain code constants (not
// runtime config); tune them here and redeploy.  See `recomputeNewsScores`
// for how they combine.
// ---------------------------------------------------------------------------

/** Weight for a sharing post authored by a local Hackers' Pub account. */
export const NEWS_SOURCE_WEIGHT_LOCAL = 1.0;
/** Weight for a sharing post from a generic remote fediverse instance. */
export const NEWS_SOURCE_WEIGHT_REMOTE = 0.8;
/** Weight for a sharing post bridged from Bluesky (`@…@bsky.brid.gy`). */
export const NEWS_SOURCE_WEIGHT_BLUESKY = 0.5;

/** Base contribution every public sharing post adds, before engagement. */
export const NEWS_W_SHARE = 1.0;
/** Weight of each quote of a sharing post (heaviest engagement signal). */
export const NEWS_W_QUOTE = 3.0;
/** Weight of each reply to a sharing post. */
export const NEWS_W_REPLY = 2.0;
/** Weight of each reaction to a sharing post (lightest engagement signal). */
export const NEWS_W_REACT = 0.5;

/** Maximum additive reputation bonus a single sharer can contribute. */
export const NEWS_ACCOUNT_WEIGHT_CAP = 2.0;
/** Scales the follower/following reputation term before the cap. */
export const NEWS_ACCOUNT_RATIO_FACTOR = 0.5;

/**
 * Fixed epoch (2024-01-01T00:00:00Z, in seconds) the recency term is measured
 * against.  Anchoring to a constant (not `now()`) is what makes the score
 * idempotent and time-stable: a link's score is a pure function of the posts
 * and engagement around it, so sorting by it never goes stale as the wall
 * clock advances; it only changes when the underlying data changes.
 */
export const NEWS_EPOCH_SECONDS = 1_704_067_200;
/**
 * Time constant (seconds) for the additive recency term.  Smaller values make
 * recency dominate engagement mass more strongly.
 */
export const NEWS_TAU_SECONDS = 50_000;

// Detects a Bluesky-bridged actor (`@…@bsky.brid.gy`).  References the actor
// alias `a` and instance alias `i`, which both source queries below join under
// those names, so the classification stays identical wherever it is reused.
// `coalesce(... , false)` keeps the predicate boolean-total: `instance.software`
// can be `null`, and a bare `null ilike …` would make `NOT condition` evaluate
// to `null` (not `true`), which would drop NULL-software remote actors out of
// the `remote` count while the recompute still scores them as remote.
const blueskyBridgeCondition: SQL = sql`(
  coalesce(i.software ilike '%bsky%', false) or a.handle_host = 'bsky.brid.gy'
)`;

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

export interface RecomputeNewsScoresOptions {
  /**
   * Restrict the recompute to these link ids.  Used by the incremental
   * single-link refresh on post write.  Omit to recompute every link.
   */
  readonly linkIds?: readonly Uuid[];
  /**
   * Restrict the recompute to links whose `latestActivityAt` is at or after
   * this instant.  Used by the periodic sweep to bound cost to recently
   * active stories.  Ignored when `linkIds` is given.
   */
  readonly activeSince?: Date;
}

export interface RecomputeNewsScoresResult {
  /** Number of links that have at least one qualifying public share. */
  readonly linksUpdated: number;
  /** When the recompute ran. */
  readonly recomputedAt: Date;
}

function isTransaction(db: Database): db is Transaction {
  return "rollback" in db;
}

/**
 * Recompute popularity scores for news links and write them onto
 * `post_link`.  Idempotent: running it repeatedly on unchanged data yields
 * identical `score`/`weightedMass`/`firstSharedAt`/`latestActivityAt`
 * (`scoreUpdated` aside).
 *
 * A "sharing post" is a publicly visible (`public`/`unlisted`), non-boost post
 * whose `linkId` points at the link.  `weightedMass` sums each sharing post's
 * source weight times account-reputation weight times its weighted engagement
 * counts; `latestActivityAt` is the freshest of the share, its reactions, and
 * its direct replies/quotes.  Links that have lost their last qualifying share
 * are reset to a zero score and dropped from the feed.
 */
export async function recomputeNewsScores(
  db: Database,
  options: RecomputeNewsScoresOptions = {},
): Promise<RecomputeNewsScoresResult> {
  const recomputedAt = new Date();
  const scope = resolveScope(options);

  // An explicit but empty link set has nothing to do; skip the round trip.
  if (scope.kind === "links" && scope.ids.length < 1) {
    return { linksUpdated: 0, recomputedAt };
  }

  const run = async (tx: Database): Promise<number> => {
    const linksUpdated = await recomputeAggregate(tx, scope);
    await zeroStaleLinks(tx, scope);
    return linksUpdated;
  };

  const linksUpdated = isTransaction(db)
    ? await run(db)
    : await db.transaction(run);
  logger.debug(
    "Recomputed news scores for {linksUpdated} link(s).",
    { linksUpdated },
  );
  return { linksUpdated, recomputedAt };
}

/**
 * Best-effort incremental refresh of specific links' scores, for the write
 * paths (a link is shared, unshared, or its sharing post changes link).  Nulls
 * are dropped and deduped; an empty set is a no-op.
 *
 * Isolation: the recompute runs in its own (sub)transaction so a scoring
 * failure rolls back only itself and is swallowed (logged) rather than
 * propagating.  This matters when `db` is already a transaction: without the
 * savepoint a Postgres error would poison the caller's transaction and block
 * the post write even though the exception is caught.  Engagement-driven
 * re-ranking (new replies, quotes, reactions on a story) is left to the
 * periodic sweep, which derives its target set from source timestamps and so
 * sees correct, settled counts.
 */
export async function refreshNewsScores(
  db: Database,
  linkIds: ReadonlyArray<Uuid | null | undefined>,
): Promise<void> {
  const ids = [...new Set(linkIds.filter((id): id is Uuid => id != null))];
  if (ids.length < 1) return;
  try {
    await db.transaction((tx) => recomputeNewsScores(tx, { linkIds: ids }));
  } catch (error) {
    logger.error(
      "Failed to refresh news scores for {linkIds}: {error}",
      { linkIds: ids, error },
    );
  }
}

/** Which links a recompute targets. */
type RecomputeScope =
  | { readonly kind: "all" }
  | { readonly kind: "links"; readonly ids: readonly Uuid[] }
  | { readonly kind: "activeSince"; readonly since: Date };

function resolveScope(options: RecomputeNewsScoresOptions): RecomputeScope {
  if (options.linkIds != null) return { kind: "links", ids: options.linkIds };
  if (options.activeSince != null) {
    return { kind: "activeSince", since: options.activeSince };
  }
  return { kind: "all" };
}

/**
 * A `AND <linkIdColumn> …` predicate that narrows a statement to the scope's
 * links, or empty SQL for a full recompute.  The set always stays inside SQL
 * (an explicit id list is bound as one `uuid[]` array; the `activeSince` set is
 * a subquery) so a large sweep never expands into thousands of bind
 * parameters.
 */
function scopeFilter(scope: RecomputeScope, linkIdColumn: SQL): SQL {
  switch (scope.kind) {
    case "all":
      return sql``;
    case "links": {
      // UUIDs contain no array-literal metacharacters, so a plain `{a,b}`
      // literal bound as a single string parameter is safe.
      const literal = `{${scope.ids.join(",")}}`;
      return sql` and ${linkIdColumn} = any(${literal}::uuid[])`;
    }
    case "activeSince":
      return sql` and ${linkIdColumn} in (${
        activeLinkIdsSubquery(scope.since)
      })`;
  }
}

/**
 * The companion of `scopeFilter` for the stale-link reset.  A link that just
 * lost its last public share is, by definition, *absent* from
 * `activeLinkIdsSubquery` (which requires a qualifying share), so the sweep
 * must scope its zeroing by the stored `latest_activity_at` instead: reset
 * recently-scored links that no longer qualify.  `all`/`links` scopes match
 * `scopeFilter`.
 */
function staleScopeFilter(scope: RecomputeScope): SQL {
  switch (scope.kind) {
    case "all":
      return sql``;
    case "links": {
      const literal = `{${scope.ids.join(",")}}`;
      return sql` and pl.id = any(${literal}::uuid[])`;
    }
    case "activeSince":
      return sql` and pl.latest_activity_at >= ${scope.since.toISOString()}::timestamptz`;
  }
}

/**
 * Subquery of link ids with any engagement at or after `activeSince`: a
 * qualifying share published since then, a reaction created since then, or a
 * public direct reply/quote published since then.  The periodic sweep scopes
 * to this (rather than the stored `latestActivityAt`) so a fresh reaction on an
 * *older* story is still picked up: that story's stored `latestActivityAt` is
 * still old, but its underlying reaction is new.
 */
function activeLinkIdsSubquery(activeSince: Date): SQL {
  // Raw `sql` does not bind a JS `Date`; pass an ISO string cast to
  // `timestamptz`.
  const since = sql`${activeSince.toISOString()}::timestamptz`;
  return sql`
    select s.link_id
    from post s
    where s.link_id is not null
      and s.visibility in ('public', 'unlisted')
      and s.shared_post_id is null
      and (
        s.published >= ${since}
        -- A federated Update to a share (e.g. its replies/likes totals) bumps
        -- the updated column, so this catches remote engagement-count changes
        -- that create no local reaction/reply/quote row.
        or s.updated >= ${since}
        or exists (
          select 1 from reaction r
          where r.post_id = s.id and r.created >= ${since}
        )
        or exists (
          select 1 from post c
          where (c.reply_target_id = s.id or c.quoted_post_id = s.id)
            and c.visibility in ('public', 'unlisted')
            and c.published >= ${since}
        )
      )
  `;
}

/**
 * The single set-based aggregation: derive per-link mass and activity from the
 * sharing posts and their engagement, then write the score.  Returns the
 * number of links written.
 */
async function recomputeAggregate(
  db: Database,
  scope: RecomputeScope,
): Promise<number> {
  const result = await db.execute(sql`
    with shares as (
      select
        p.link_id as link_id,
        p.id as post_id,
        p.published as published,
        p.quotes_count as quotes_count,
        p.replies_count as replies_count,
        p.reactions_count as reactions_count,
        case
          when a.account_id is not null then ${NEWS_SOURCE_WEIGHT_LOCAL}::double precision
          when ${blueskyBridgeCondition}
            then ${NEWS_SOURCE_WEIGHT_BLUESKY}::double precision
          else ${NEWS_SOURCE_WEIGHT_REMOTE}::double precision
        end as source_weight,
        (1 + least(
          ${NEWS_ACCOUNT_WEIGHT_CAP}::double precision,
          log((1 + greatest(a.followers_count, 0))::double precision)
            * (1 + greatest(a.followers_count, 0)::double precision
                / (greatest(a.followees_count, 0) + 1))
            * ${NEWS_ACCOUNT_RATIO_FACTOR}::double precision
        )) as account_weight
      from post p
      join actor a on a.id = p.actor_id
      join instance i on i.host = a.instance_host
      where p.link_id is not null
        and p.visibility in ('public', 'unlisted')
        and p.shared_post_id is null${scopeFilter(scope, sql`p.link_id`)}
    ),
    child_activity as (
      select s.link_id as link_id, max(c.published) as latest
      from shares s
      join post c
        on (c.reply_target_id = s.post_id or c.quoted_post_id = s.post_id)
        and c.visibility in ('public', 'unlisted')
      group by s.link_id
    ),
    reaction_activity as (
      select s.link_id as link_id, max(r.created) as latest
      from shares s
      join reaction r on r.post_id = s.post_id
      group by s.link_id
    ),
    agg as (
      select
        s.link_id as link_id,
        count(*) as post_count,
        min(s.published) as first_shared_at,
        max(s.published) as latest_share,
        sum(
          s.source_weight * s.account_weight * (
            ${NEWS_W_SHARE}::double precision
            + ${NEWS_W_QUOTE}::double precision * s.quotes_count
            + ${NEWS_W_REPLY}::double precision * s.replies_count
            + ${NEWS_W_REACT}::double precision * s.reactions_count
          )
        ) as weighted_mass
      from shares s
      group by s.link_id
    ),
    final as (
      select
        agg.link_id as link_id,
        agg.post_count as post_count,
        agg.first_shared_at as first_shared_at,
        greatest(agg.latest_share, ca.latest, ra.latest) as latest_activity_at,
        agg.weighted_mass as weighted_mass
      from agg
      left join child_activity ca on ca.link_id = agg.link_id
      left join reaction_activity ra on ra.link_id = agg.link_id
    )
    update post_link pl set
      post_count = final.post_count,
      -- Truncate to milliseconds so the stored value matches the precision of
      -- the JS-Date-derived NEWEST feed cursor (toISOString is ms-only);
      -- otherwise sub-millisecond rows after a cursor would be skipped.
      first_shared_at = date_trunc('milliseconds', final.first_shared_at),
      latest_activity_at = final.latest_activity_at,
      weighted_mass = final.weighted_mass,
      recency_component =
        (extract(epoch from final.latest_activity_at) - ${NEWS_EPOCH_SECONDS}::double precision)
          / ${NEWS_TAU_SECONDS}::double precision,
      score =
        log(greatest(1::double precision, final.weighted_mass))
        + (extract(epoch from final.latest_activity_at) - ${NEWS_EPOCH_SECONDS}::double precision)
            / ${NEWS_TAU_SECONDS}::double precision,
      score_updated = now()
    from final
    where pl.id = final.link_id
    returning pl.id
  `);
  return result.length;
}

/**
 * Reset links that were scored before but no longer have any qualifying public
 * share, so they drop out of the feed indexes.
 */
async function zeroStaleLinks(
  db: Database,
  scope: RecomputeScope,
): Promise<void> {
  await db.execute(sql`
    update post_link pl set
      score = 0,
      weighted_mass = 0,
      recency_component = 0,
      post_count = 0,
      first_shared_at = null,
      latest_activity_at = null,
      score_updated = now()
    where pl.latest_activity_at is not null${staleScopeFilter(scope)}
      and not exists (
        select 1 from post p
        where p.link_id = pl.id
          and p.visibility in ('public', 'unlisted')
          and p.shared_post_id is null
      )
  `);
}

// ---------------------------------------------------------------------------
// Feed reads
// ---------------------------------------------------------------------------

export type NewsOrder = "popular" | "newest" | "allTime";

export interface NewsStoriesCursor {
  /** The active order's sort scalar of the last row on the previous page. */
  readonly value: number | Date;
  /** The id of the last row on the previous page (keyset tiebreaker). */
  readonly id: Uuid;
}

export interface GetNewsStoriesOptions {
  readonly order: NewsOrder;
  readonly limit: number;
  readonly after?: NewsStoriesCursor;
}

/**
 * Read a page of ranked news links (newest/most-popular first).  Keyset
 * pagination on `(sortKey, id)` matching the partial feed indexes; pass the
 * previous page's last row as `after`.  Only links with at least one public
 * share (`latestActivityAt IS NOT NULL`) are returned.
 */
export async function getNewsStories(
  db: Database,
  options: GetNewsStoriesOptions,
): Promise<PostLink[]> {
  const sortColumn = options.order === "newest"
    ? postLinkTable.firstSharedAt
    : options.order === "allTime"
    ? postLinkTable.weightedMass
    : postLinkTable.score;

  const conditions: SQL[] = [isNotNull(postLinkTable.latestActivityAt)];
  if (options.after != null) {
    const { value, id } = options.after;
    conditions.push(
      or(
        lt(sortColumn, value),
        and(eq(sortColumn, value), lt(postLinkTable.id, id)),
      )!,
    );
  }

  return await db
    .select()
    .from(postLinkTable)
    .where(and(...conditions))
    .orderBy(desc(sortColumn), desc(postLinkTable.id))
    .limit(options.limit);
}

// ---------------------------------------------------------------------------
// Status (admin)
// ---------------------------------------------------------------------------

export interface NewsScoreStatus {
  /** Links currently in the feed (with at least one public share). */
  readonly scoredLinkCount: number;
  /** When scores were last recomputed, or `null` if never. */
  readonly lastRecomputedAt: Date | null;
}

/** Snapshot of news scoring state for the moderator admin page. */
export async function getNewsScoreStatus(
  db: Database,
): Promise<NewsScoreStatus> {
  const [counts] = await db
    .select({ scoredLinkCount: count() })
    .from(postLinkTable)
    .where(isNotNull(postLinkTable.latestActivityAt));
  // Read the column directly (ordered, not aggregated) so drizzle applies the
  // timestamptz -> Date mapping; `max()` would hand back a raw Postgres string
  // the GraphQL `DateTime` scalar then refuses to serialize.
  const [latest] = await db
    .select({ scoreUpdated: postLinkTable.scoreUpdated })
    .from(postLinkTable)
    .where(isNotNull(postLinkTable.scoreUpdated))
    .orderBy(desc(postLinkTable.scoreUpdated))
    .limit(1);
  return {
    scoredLinkCount: Number(counts?.scoredLinkCount ?? 0),
    lastRecomputedAt: latest?.scoreUpdated ?? null,
  };
}

// ---------------------------------------------------------------------------
// Source breakdown
// ---------------------------------------------------------------------------

export interface NewsSourceBreakdown {
  /** Public sharing posts from local Hackers' Pub accounts. */
  readonly local: number;
  /** Public sharing posts from generic remote fediverse instances. */
  readonly remote: number;
  /** Public sharing posts bridged from Bluesky (`@…@bsky.brid.gy`). */
  readonly bluesky: number;
}

/**
 * Count, per link, how many of its public sharing posts come from local,
 * generic-remote, and Bluesky-bridged accounts.  Batched for the GraphQL
 * `PostLink.sourceBreakdown` loader; links with no public share are absent
 * from the returned map.
 */
export async function getNewsSourceBreakdowns(
  db: Database,
  linkIds: readonly Uuid[],
): Promise<Map<Uuid, NewsSourceBreakdown>> {
  const result = new Map<Uuid, NewsSourceBreakdown>();
  const ids = [...new Set(linkIds)];
  if (ids.length < 1) return result;
  const literal = `{${ids.join(",")}}`;
  const rows = await db.execute<
    { link_id: Uuid; local: string; remote: string; bluesky: string }
  >(sql`
    select
      p.link_id as link_id,
      count(*) filter (where a.account_id is not null) as local,
      count(*) filter (
        where a.account_id is null and ${blueskyBridgeCondition}
      ) as bluesky,
      count(*) filter (
        where a.account_id is null and not ${blueskyBridgeCondition}
      ) as remote
    from post p
    join actor a on a.id = p.actor_id
    join instance i on i.host = a.instance_host
    where p.link_id = any(${literal}::uuid[])
      and p.visibility in ('public', 'unlisted')
      and p.shared_post_id is null
    group by p.link_id
  `);
  for (const row of rows) {
    result.set(row.link_id, {
      local: Number(row.local),
      remote: Number(row.remote),
      bluesky: Number(row.bluesky),
    });
  }
  return result;
}
