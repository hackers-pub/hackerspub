import { getLogger } from "@logtape/logtape";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database, Transaction } from "./db.ts";
import {
  type ActorType,
  type NewsExcludedPattern,
  newsExcludedPatternTable,
  type PostLink,
  postLinkTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

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

// ---------------------------------------------------------------------------
// Repeated-share damping
//
// The same account re-sharing the same link should not pile up score: from its
// second share of a given link onward, the extra base-share weight is heavily
// discounted, recovering with the gap since that account's previous share of
// the link but never reaching a first share's weight.  A short-gap repeat also
// does not refresh the link's freshness, so rapid re-sharing cannot pin a link
// at the top (genuine replies/quotes/reactions still do).
// ---------------------------------------------------------------------------

/**
 * Maximum base-share weight a *repeat* share of the same link by the same
 * account can contribute, as a fraction of a first share.  Strictly `< 1`, so a
 * repeat is always lighter than the first share however long the gap.
 */
export const NEWS_REPEAT_CAP = 0.5;
/**
 * Time constant (seconds) over which a repeat share's base weight recovers
 * toward `NEWS_REPEAT_CAP` as the gap since the account's previous share of the
 * same link grows.  Larger values mean the weight recovers more slowly.
 */
export const NEWS_REPEAT_RECOVERY_TAU_SECONDS = 2_592_000; // 30 days
/**
 * Minimum gap (seconds) since an account's previous share of the same link for
 * a repeat share to refresh the link's freshness (`latestActivityAt`).  Below
 * this, a repeat is not treated as fresh activity (so rapid re-sharing cannot
 * pin a link at the top); genuine replies/quotes/reactions still refresh it.
 */
export const NEWS_REPEAT_FRESH_MIN_SECONDS = 604_800; // 7 days

// ---------------------------------------------------------------------------
// Moderator score penalties
//
// A moderator demotes a link by subtracting a penalty from its `score` (the
// `POPULAR` order).  Presets, not free numbers, since the raw score scale is
// recency-dominated and unintuitive.  Tunable.
// ---------------------------------------------------------------------------

/**
 * "Demote": push a link well down the popular feed (roughly a month of recency
 * worth of score), without removing it.
 */
export const NEWS_PENALTY_DEMOTE = 50;
/**
 * "Bury": sink a link to the very bottom of the popular feed.  Large enough that
 * the score goes negative regardless of engagement/recency.  (To remove a link
 * from every order, use an exclusion pattern instead.)
 */
export const NEWS_PENALTY_BURY = 100_000;

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

/**
 * Actor types treated as bots, whose *shares* are excluded from News: a link
 * shared only by `Service`/`Application` actors (automated link feeds) must not
 * surface as a news story.  `Person`, `Group`, and `Organization` stay
 * eligible.  Replies/quotes/reactions are not filtered by author; only the
 * sharing post's actor type matters.  Exported so the GraphQL `sharingPosts`
 * filter stays in lockstep with this SQL.
 */
export const NEWS_BOT_ACTOR_TYPES: readonly ActorType[] = [
  "Service",
  "Application",
];

/**
 * Whether an actor `type` is treated as a bot for News purposes (its shares are
 * excluded).  Use this to detect when a federated actor crosses the bot/non-bot
 * boundary so the links it shares can be re-scored.
 */
export function isNewsBotActorType(type: ActorType): boolean {
  return NEWS_BOT_ACTOR_TYPES.includes(type);
}

// A qualifying sharing post must be authored by a non-bot actor.  References the
// actor alias `a`, which every source query below joins under that name.  Cast
// `a.type` to text so the bound type list compares cleanly (an enum column has
// no implicit operator against a bound text parameter), keeping a single source
// of truth with `NEWS_BOT_ACTOR_TYPES`.
const nonBotSharerCondition: SQL = sql`a.type::text not in (${
  sql.join(NEWS_BOT_ACTOR_TYPES.map((t) => sql`${t}`), sql`, `)
})`;

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
    // Flag newly-scored (or rescored) links that match an exclusion pattern.
    // Scope the pass to the links this recompute touched so the periodic
    // `activeSince` sweep stays O(active links) instead of re-testing every
    // scored link on each run; a full (`all`) recompute re-evaluates all of
    // them, which is what it is for.
    const exclusionScope = scope.kind === "links"
      ? scope.ids
      : scope.kind === "activeSince"
      ? await activeLinkIds(tx, scope.since)
      : undefined;
    await applyNewsExclusions(tx, exclusionScope);
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

/**
 * Refresh the news score for the link a post shares, given only the post's id.
 * For destructive paths (e.g. a federated reaction undo) that hold the post id
 * but not its row, and which the source-derived sweep cannot detect.
 */
export async function refreshNewsScoresForPostId(
  db: Database,
  postId: Uuid,
): Promise<void> {
  const post = await db.query.postTable.findFirst({
    where: { id: postId },
    columns: { linkId: true },
  });
  if (post?.linkId != null) await refreshNewsScores(db, [post.linkId]);
}

/**
 * Refresh the links a removed or changed post affects: its own shared link,
 * plus the link of any post it replied to or quoted (whose public reply/quote
 * count just changed).  Used by the destructive paths (delete, quote revoke),
 * which the source-derived periodic sweep cannot detect, so without this a
 * deleted share or reply could keep a link in the feed or inflate its mass
 * until a manual full recompute.
 */
export async function refreshNewsScoresForPostLinks(
  db: Database,
  post: {
    readonly linkId: Uuid | null;
    readonly replyTargetId: Uuid | null;
    readonly quotedPostId: Uuid | null;
  },
): Promise<void> {
  const linkIds = new Set<Uuid>();
  if (post.linkId != null) linkIds.add(post.linkId);
  const parentIds = [post.replyTargetId, post.quotedPostId].filter(
    (id): id is Uuid => id != null,
  );
  if (parentIds.length > 0) {
    const parents = await db.query.postTable.findMany({
      where: { id: { in: parentIds } },
      columns: { linkId: true },
    });
    for (const parent of parents) {
      if (parent.linkId != null) linkIds.add(parent.linkId);
    }
  }
  await refreshNewsScores(db, [...linkIds]);
}

/**
 * Refresh every link an actor shares, for when the actor's `type` crosses the
 * bot/non-bot boundary (e.g. a remote `Person` toggles Mastodon's bot flag and
 * federates as a `Service`).  Such a transition silently changes which of the
 * actor's shares qualify, and the periodic sweep cannot detect it (its active
 * set is keyed on recent *qualifying* activity, which the just-(un)botted share
 * may no longer have), so the caller must trigger this explicitly.
 */
export async function refreshNewsScoresForActor(
  db: Database,
  actorId: Uuid,
): Promise<void> {
  const shares = await db.query.postTable.findMany({
    where: {
      actorId,
      linkId: { isNotNull: true },
      sharedPostId: { isNull: true },
    },
    columns: { linkId: true },
  });
  await refreshNewsScores(db, shares.map((s) => s.linkId));
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
 *
 * The `activeSince` set is materialized with `= any(array(…))` rather than
 * `in (…)`: against the millions-of-rows `post` table the planner otherwise
 * hash-semi-joins by scanning every sharing post, whereas the array form drives
 * a nested loop that looks the (few thousand) active links up through
 * `idx_post_news_share_link`, reading only their shares.
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
      return sql` and ${linkIdColumn} = any(array(${
        activeLinkIdsSubquery(scope.since)
      }))`;
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
  // `s` is a qualifying share: carries a link, publicly visible, an original
  // post (not a boost).
  const share = sql`
    s.link_id is not null
      and s.visibility in ('public', 'unlisted')
      and s.shared_post_id is null
  `;
  // A `union` of one lookup per kind of activity, each bounded by `activeSince`
  // so the planner ranges a recency index (post.published / post.updated /
  // reaction.created, plus idx_post_visibility_published for replies/quotes)
  // instead of scanning every sharing post and testing it row by row. This is
  // equivalent to the former "any sharing post with activity since" single
  // scan, but its cost is O(activity in the window) rather than O(all sharing
  // posts ever). Each branch yields the `link_id` of a share that saw that kind
  // of recent activity.
  return sql`
    select s.link_id
      from post s join actor a on a.id = s.actor_id
      where ${share} and ${nonBotSharerCondition} and s.published >= ${since}
    union
    select s.link_id
      from post s join actor a on a.id = s.actor_id
      -- A federated Update to a share (e.g. its replies/likes totals) bumps
      -- the updated column, catching remote engagement changes with no row.
      where ${share} and ${nonBotSharerCondition} and s.updated >= ${since}
    union
    select s.link_id
      from reaction r
      join post s on s.id = r.post_id
      join actor a on a.id = s.actor_id
      where r.created >= ${since} and ${share} and ${nonBotSharerCondition}
    union
    select s.link_id
      from post c
      join post s on s.id = c.reply_target_id
      join actor a on a.id = s.actor_id
      where c.reply_target_id is not null
        and c.visibility in ('public', 'unlisted') and c.published >= ${since}
        and ${share} and ${nonBotSharerCondition}
    union
    select s.link_id
      from post c
      join post s on s.id = c.quoted_post_id
      join actor a on a.id = s.actor_id
      where c.quoted_post_id is not null
        and c.visibility in ('public', 'unlisted') and c.published >= ${since}
        and ${share} and ${nonBotSharerCondition}
  `;
}

/**
 * Materialize the `activeSince` link set so the exclusion pass can be scoped to
 * the same links the recompute touched, rather than re-testing every scored
 * link.  Deduped, since the subquery yields one row per qualifying share.
 */
async function activeLinkIds(db: Database, activeSince: Date): Promise<Uuid[]> {
  const rows = await db.execute(
    activeLinkIdsSubquery(activeSince),
  ) as unknown as { link_id: Uuid }[];
  return [...new Set(rows.map((row) => row.link_id))];
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
        )) as account_weight,
        -- Seconds since this account's previous share of this same link (NULL
        -- for its first share), to damp repeated re-shares below.
        extract(epoch from (
          p.published - lag(p.published) over (
            partition by p.actor_id, p.link_id order by p.published, p.id
          )
        )) as gap_seconds
      from post p
      join actor a on a.id = p.actor_id
      join instance i on i.host = a.instance_host
      where p.link_id is not null
        and p.visibility in ('public', 'unlisted')
        and p.shared_post_id is null
        and ${nonBotSharerCondition}${scopeFilter(scope, sql`p.link_id`)}
    ),
    -- Count only public/unlisted replies and quotes: the denormalized
    -- replies_count/quotes_count include followers-only and direct posts,
    -- which must not influence (or leak through) a public news score.
    reply_counts as (
      select s.post_id as post_id, count(*) as cnt
      from shares s
      join post c on c.reply_target_id = s.post_id
        and c.visibility in ('public', 'unlisted')
      group by s.post_id
    ),
    quote_counts as (
      select s.post_id as post_id, count(*) as cnt
      from shares s
      join post c on c.quoted_post_id = s.post_id
        and c.visibility in ('public', 'unlisted')
      group by s.post_id
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
        -- Only a first share or a sufficiently-gapped re-share refreshes the
        -- link's freshness, so rapid re-sharing cannot pin it at the top.
        -- (Genuine replies/quotes/reactions still refresh it via the activity
        -- CTEs below.)  Every account's first share has a NULL gap, so this is
        -- non-NULL whenever the link has any share.
        max(s.published) filter (
          where s.gap_seconds is null
            or s.gap_seconds >= ${NEWS_REPEAT_FRESH_MIN_SECONDS}::double precision
        ) as latest_share,
        sum(
          s.source_weight * s.account_weight * (
            -- Damp only the base share weight of a repeat: it recovers toward
            -- NEWS_REPEAT_CAP as the gap since this account's previous share of
            -- this link grows, but never reaches a first share's weight.  The
            -- per-post engagement below is never discounted.
            ${NEWS_W_SHARE}::double precision * (
              case
                when s.gap_seconds is null then 1::double precision
                else ${NEWS_REPEAT_CAP}::double precision * (
                  1 - exp(
                    -s.gap_seconds
                      / ${NEWS_REPEAT_RECOVERY_TAU_SECONDS}::double precision
                  )
                )
              end
            )
            + ${NEWS_W_QUOTE}::double precision * coalesce(qc.cnt, 0)
            + ${NEWS_W_REPLY}::double precision * coalesce(rc.cnt, 0)
            + ${NEWS_W_REACT}::double precision * s.reactions_count
          )
        ) as weighted_mass
      from shares s
      left join reply_counts rc on rc.post_id = s.post_id
      left join quote_counts qc on qc.post_id = s.post_id
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
            / ${NEWS_TAU_SECONDS}::double precision
        - pl.score_penalty,
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
        join actor a on a.id = p.actor_id
        where p.link_id = pl.id
          and p.visibility in ('public', 'unlisted')
          and p.shared_post_id is null
          and ${nonBotSharerCondition}
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

  const conditions: SQL[] = [
    isNotNull(postLinkTable.latestActivityAt),
    eq(postLinkTable.excludedFromNews, false),
  ];
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
      and ${nonBotSharerCondition}
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

// ---------------------------------------------------------------------------
// Discussion count
// ---------------------------------------------------------------------------

/**
 * Count, per link, the size of its federated discussion: the non-bot public
 * sharing posts plus their direct public (`public`/`unlisted`) replies and
 * quotes.  Batched for the GraphQL `PostLink.discussionCount` loader; links
 * with no qualifying share are absent from the returned map.  Counts direct
 * children only (deeper nesting is not traversed); replies/quotes are not
 * author-filtered, matching the discussion the link's page renders.
 */
export async function getNewsDiscussionCounts(
  db: Database,
  linkIds: readonly Uuid[],
): Promise<Map<Uuid, number>> {
  const result = new Map<Uuid, number>();
  const ids = [...new Set(linkIds)];
  if (ids.length < 1) return result;
  const literal = `{${ids.join(",")}}`;
  // Collect each link's distinct posts as `(link_id, post_id)` pairs (the
  // sharing posts plus their direct public replies and quotes), then count per
  // link.  `union` (not `union all`) deduplicates, so a single post that is
  // both a reply and a quote of the link's shares (or replies to one share and
  // quotes another) is counted once, matching the deduplicated discussion tree.
  const rows = await db.execute<{ link_id: Uuid; cnt: string | number }>(sql`
    with shares as (
      select p.id as post_id, p.link_id as link_id
      from post p
      join actor a on a.id = p.actor_id
      where p.link_id = any(${literal}::uuid[])
        and p.visibility in ('public', 'unlisted')
        and p.shared_post_id is null
        and ${nonBotSharerCondition}
    )
    select link_id, count(*) as cnt
    from (
      select link_id, post_id from shares
      union
      select s.link_id, c.id as post_id
        from shares s
        join post c on c.reply_target_id = s.post_id
          and c.visibility in ('public', 'unlisted')
      union
      select s.link_id, c.id as post_id
        from shares s
        join post c on c.quoted_post_id = s.post_id
          and c.visibility in ('public', 'unlisted')
    ) posts
    group by link_id
  `);
  for (const row of rows) {
    result.set(row.link_id, Number(row.cnt));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Moderation: exclusion patterns + score penalties
// ---------------------------------------------------------------------------

/** Thrown when a news exclusion pattern is not a valid `URLPattern`. */
export class InvalidNewsPatternError extends Error {}

/**
 * Re-evaluate `excludedFromNews` for the given links (or every scored link when
 * omitted) against the current exclusion patterns: a link is excluded when its
 * URL matches any pattern (Web-standard `URLPattern`).  Invalid stored patterns
 * are skipped (and logged).  Only rows whose flag actually changes are written.
 */
export async function applyNewsExclusions(
  db: Database,
  linkIds?: readonly Uuid[],
): Promise<void> {
  if (linkIds != null && linkIds.length < 1) return;
  const scope = linkIds != null
    ? inArray(postLinkTable.id, [...linkIds])
    : isNotNull(postLinkTable.latestActivityAt);

  const patternRows = await db
    .select({ pattern: newsExcludedPatternTable.pattern })
    .from(newsExcludedPatternTable);
  const patterns: URLPattern[] = [];
  for (const { pattern } of patternRows) {
    try {
      patterns.push(new URLPattern(pattern));
    } catch (error) {
      logger.warn(
        "Skipping invalid news exclusion pattern {pattern}: {error}",
        { pattern, error },
      );
    }
  }

  const links = await db
    .select({ id: postLinkTable.id, url: postLinkTable.url })
    .from(postLinkTable)
    .where(scope);
  const excludedIds = links
    .filter((link) => patterns.some((p) => p.test(link.url)))
    .map((link) => link.id);
  const literal = `{${excludedIds.join(",")}}`;
  const target = sql`${postLinkTable.id} = any(${literal}::uuid[])`;
  // `is distinct from` skips no-op writes so a periodic full pass does not churn
  // every scored row.
  await db
    .update(postLinkTable)
    .set({ excludedFromNews: target })
    .where(
      and(
        scope,
        sql`${postLinkTable.excludedFromNews} is distinct from ${target}`,
      ),
    );
}

/** List all exclusion patterns, newest first (for the admin page). */
export function getNewsExcludedPatterns(
  db: Database,
): Promise<NewsExcludedPattern[]> {
  return db
    .select()
    .from(newsExcludedPatternTable)
    .orderBy(desc(newsExcludedPatternTable.created));
}

/**
 * Add an exclusion pattern (idempotent on the pattern string) and re-flag every
 * scored link against it.  Throws `InvalidNewsPatternError` if the pattern is
 * not a valid `URLPattern`.
 */
export async function addNewsExcludedPattern(
  db: Database,
  values: { pattern: string; note?: string | null; creatorId?: Uuid | null },
): Promise<NewsExcludedPattern> {
  const pattern = values.pattern.trim();
  if (pattern.length < 1) {
    throw new InvalidNewsPatternError("Pattern must not be empty.");
  }
  try {
    new URLPattern(pattern);
  } catch (error) {
    throw new InvalidNewsPatternError(
      `Invalid URLPattern: ${pattern} (${error})`,
    );
  }
  const run = async (tx: Database): Promise<NewsExcludedPattern> => {
    const inserted = await tx
      .insert(newsExcludedPatternTable)
      .values({
        id: generateUuidV7(),
        pattern,
        note: values.note?.trim() || null,
        creatorId: values.creatorId ?? null,
      })
      .onConflictDoNothing({ target: newsExcludedPatternTable.pattern })
      .returning();
    let row = inserted[0];
    if (row == null) {
      [row] = await tx
        .select()
        .from(newsExcludedPatternTable)
        .where(eq(newsExcludedPatternTable.pattern, pattern))
        .limit(1);
    }
    if (row == null) throw new Error("Failed to persist exclusion pattern.");
    await applyNewsExclusions(tx);
    return row;
  };
  return isTransaction(db) ? await run(db) : await db.transaction(run);
}

/** Remove an exclusion pattern and un-flag links it no longer matches. */
export async function removeNewsExcludedPattern(
  db: Database,
  id: Uuid,
): Promise<boolean> {
  const run = async (tx: Database): Promise<boolean> => {
    const rows = await tx
      .delete(newsExcludedPatternTable)
      .where(eq(newsExcludedPatternTable.id, id))
      .returning();
    if (rows.length < 1) return false;
    await applyNewsExclusions(tx);
    return true;
  };
  return isTransaction(db) ? await run(db) : await db.transaction(run);
}

/**
 * Set a link's moderator score penalty (subtracted from its `score`) and
 * recompute that link so the feed reflects it.
 */
export async function setNewsScorePenalty(
  db: Database,
  linkId: Uuid,
  penalty: number,
): Promise<void> {
  // Guard against a negative penalty (which would *boost* the score) or a
  // non-finite value poisoning the ranking column.
  if (!Number.isFinite(penalty) || penalty < 0) {
    throw new RangeError(`Invalid news score penalty: ${penalty}`);
  }
  const run = async (tx: Database): Promise<void> => {
    await tx
      .update(postLinkTable)
      .set({ scorePenalty: penalty })
      .where(eq(postLinkTable.id, linkId));
    await recomputeNewsScores(tx, { linkIds: [linkId] });
  };
  if (isTransaction(db)) await run(db);
  else await db.transaction(run);
}

/** Links currently carrying a moderator penalty, heaviest first (admin review). */
export function getNewsPenalizedStories(db: Database): Promise<PostLink[]> {
  return db
    .select()
    .from(postLinkTable)
    .where(gt(postLinkTable.scorePenalty, 0))
    .orderBy(desc(postLinkTable.scorePenalty), desc(postLinkTable.id))
    .limit(100);
}
