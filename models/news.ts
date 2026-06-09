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
import type { Database, RelationsFilter, Transaction } from "./db.ts";
import {
  type ActorType,
  type NewsExcludedPattern,
  newsExcludedPatternTable,
  type NewsPreferredSharer,
  newsPreferredSharerTable,
  newsRescoreQueueTable,
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

// ---------------------------------------------------------------------------
// Moderator promotion bonuses
//
// A `news_preferred_sharer` lifts the links it shares by *adding* a flat bonus
// to their `score` (the mirror image of a penalty).  Because the score is
// recency-dominated and unintuitive these are coarse presets, not free numbers:
// one point of score is `NEWS_TAU_SECONDS` (~14h) of recency, so `NORMAL` is
// worth roughly a month of freshness (matching `NEWS_PENALTY_DEMOTE`'s scale)
// and `STRONG` several months.  A penalty on the link overrides the bonus (the
// recompute zeroes the promotion while `scorePenalty > 0`).
// ---------------------------------------------------------------------------

/** Default promotion: reliably surfaces a curated sharer's links without pinning. */
export const NEWS_PROMOTE_NORMAL = 50;
/** Stronger promotion for a high-signal curated feed (e.g. a Hacker News reposter). */
export const NEWS_PROMOTE_STRONG = 200;

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

// A qualifying sharing post is authored by an actor whose shares count toward
// News: a non-bot actor (`Person`/`Group`/`Organization`), or *any* actor a
// moderator has curated as a `news_preferred_sharer`.  The latter is what
// whitelists an otherwise-excluded bot feed (e.g. a Hacker News reposter) so its
// shares surface at all.  References the actor alias `a`, which every source
// query below joins under that name.  Cast `a.type` to text so the bound type
// list compares cleanly (an enum column has no implicit operator against a bound
// text parameter), keeping a single source of truth with `NEWS_BOT_ACTOR_TYPES`
// (and with `newsSharerActorFilter`, the relational-query mirror GraphQL uses).
const qualifyingSharerCondition: SQL = sql`(
  a.type::text not in (${
  sql.join(NEWS_BOT_ACTOR_TYPES.map((t) => sql`${t}`), sql`, `)
})
  or exists (
    select 1 from news_preferred_sharer ps where ps.actor_id = a.id
  )
)`;

/**
 * The relational-query mirror of `qualifyingSharerCondition`, for the GraphQL
 * `PostLink.sharingPosts` filter: a direct linked sharing post is authored by a
 * non-bot actor, or a curated `news_preferred_sharer` (which whitelists a bot
 * feed).  This mirrors only the actor qualification: `Article` boosts can also
 * count toward `score`/`postCount`, but they are not direct discussion roots.
 *
 * Expressed as a `postTable` filter (not an `actorTable` one) so the preferred-
 * sharer branch can use a top-level `RAW`: Drizzle hands a *nested* relation
 * filter's `RAW` callback the outer table, so the correlated EXISTS must be
 * anchored on `post.actorId` here rather than reached through `actor: { … }`.
 */
export function newsSharerPostFilter(): RelationsFilter<"postTable"> {
  return {
    OR: [
      { actor: { type: { notIn: [...NEWS_BOT_ACTOR_TYPES] } } },
      {
        RAW: (post) =>
          sql`exists (select 1 from ${newsPreferredSharerTable} ps where ps.actor_id = ${post.actorId})`,
      },
    ],
  };
}

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
 * A "sharing post" is either a publicly visible (`public`/`unlisted`),
 * non-boost post whose `linkId` points at the link, or a public boost of an
 * `Article` whose own `linkId` points at the link.  `weightedMass` sums each
 * sharing post's source weight times account-reputation weight times its
 * weighted engagement counts; `latestActivityAt` is the freshest of the share,
 * its reactions, and its direct replies/quotes.  Links that have lost their
 * last qualifying share are reset to a zero score and dropped from the feed.
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
 * but not its row, and which the source-derived sweep cannot detect.  If the
 * post is an `Article` boost, refresh the original article's backing link.
 */
export async function refreshNewsScoresForPostId(
  db: Database,
  postId: Uuid,
): Promise<void> {
  const post = await db.query.postTable.findFirst({
    where: { id: postId },
    columns: { linkId: true, sharedPostId: true },
  });
  if (post == null) return;
  const linkIds = new Set<Uuid>();
  if (post.linkId != null) linkIds.add(post.linkId);
  for (
    const linkId of await articleBoostLinkIds(db, [post.sharedPostId])
  ) {
    linkIds.add(linkId);
  }
  await refreshNewsScores(db, [...linkIds]);
}

async function articleBoostLinkIds(
  db: Database,
  sharedPostIds: ReadonlyArray<Uuid | null | undefined>,
): Promise<Uuid[]> {
  const ids = [
    ...new Set(sharedPostIds.filter((id): id is Uuid => id != null)),
  ];
  if (ids.length < 1) return [];
  const originals = await db.query.postTable.findMany({
    where: {
      id: { in: ids },
      type: "Article",
      linkId: { isNotNull: true },
    },
    columns: { linkId: true },
  });
  return originals.map((post) => post.linkId).filter((id): id is Uuid =>
    id != null
  );
}

/**
 * Refresh the links a removed or changed post affects: its own shared link,
 * the backing link of an `Article` it boosts, plus the corresponding link of
 * any post it replied to or quoted (whose public reply/quote count just
 * changed).  Used by the destructive paths (delete, quote revoke), which the
 * source-derived periodic sweep cannot detect, so without this a deleted share
 * or reply could keep a link in the feed or inflate its mass until a manual
 * full recompute.
 */
export async function refreshNewsScoresForPostLinks(
  db: Database,
  post: {
    readonly linkId: Uuid | null;
    readonly sharedPostId?: Uuid | null;
    readonly replyTargetId: Uuid | null;
    readonly quotedPostId: Uuid | null;
  },
): Promise<void> {
  const linkIds = new Set<Uuid>();
  if (post.linkId != null) linkIds.add(post.linkId);
  for (
    const linkId of await articleBoostLinkIds(db, [post.sharedPostId])
  ) {
    linkIds.add(linkId);
  }
  const parentIds = [post.replyTargetId, post.quotedPostId].filter(
    (id): id is Uuid => id != null,
  );
  if (parentIds.length > 0) {
    const parents = await db.query.postTable.findMany({
      where: { id: { in: parentIds } },
      columns: { linkId: true, sharedPostId: true },
    });
    for (const parent of parents) {
      if (parent.linkId != null) linkIds.add(parent.linkId);
    }
    for (
      const linkId of await articleBoostLinkIds(
        db,
        parents.map((parent) => parent.sharedPostId),
      )
    ) {
      linkIds.add(linkId);
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
  await refreshNewsScores(db, await actorSharedLinkIds(db, actorId));
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
  // `s` is a qualifying direct share: carries a link, publicly visible, and is
  // an original post (not a boost).
  const directShare = sql`
    s.link_id is not null
      and s.visibility in ('public', 'unlisted')
      and s.shared_post_id is null
  `;
  // `s` is a qualifying Article boost: the boost itself is public, and its
  // public original is an `Article` whose own URL backs the news link.
  const articleBoost = sql`
    original.type = 'Article'
      and original.link_id is not null
      and original.visibility in ('public', 'unlisted')
      and s.visibility in ('public', 'unlisted')
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
      where ${directShare} and ${qualifyingSharerCondition} and s.published >= ${since}
    union
    select original.link_id
      from post s
      join post original on original.id = s.shared_post_id
      join actor a on a.id = s.actor_id
      where ${articleBoost} and ${qualifyingSharerCondition} and s.published >= ${since}
    union
    select s.link_id
      from post s join actor a on a.id = s.actor_id
      -- A federated Update to a share (e.g. its replies/likes totals) bumps
      -- the updated column, catching remote engagement changes with no row.
      where ${directShare} and ${qualifyingSharerCondition} and s.updated >= ${since}
    union
    select original.link_id
      from post s
      join post original on original.id = s.shared_post_id
      join actor a on a.id = s.actor_id
      -- A federated Update to an Article boost can carry remote engagement
      -- changes with no local child/reaction row.
      where ${articleBoost} and ${qualifyingSharerCondition} and s.updated >= ${since}
    union
    select s.link_id
      from reaction r
      join post s on s.id = r.post_id
      join actor a on a.id = s.actor_id
      where r.created >= ${since} and ${directShare} and ${qualifyingSharerCondition}
    union
    select original.link_id
      from reaction r
      join post s on s.id = r.post_id
      join post original on original.id = s.shared_post_id
      join actor a on a.id = s.actor_id
      where r.created >= ${since} and ${articleBoost} and ${qualifyingSharerCondition}
    union
    select s.link_id
      from post c
      join post s on s.id = c.reply_target_id
      join actor a on a.id = s.actor_id
      where c.reply_target_id is not null
        and c.visibility in ('public', 'unlisted') and c.published >= ${since}
        and ${directShare} and ${qualifyingSharerCondition}
    union
    select original.link_id
      from post c
      join post s on s.id = c.reply_target_id
      join post original on original.id = s.shared_post_id
      join actor a on a.id = s.actor_id
      where c.reply_target_id is not null
        and c.visibility in ('public', 'unlisted') and c.published >= ${since}
        and ${articleBoost} and ${qualifyingSharerCondition}
    union
    select s.link_id
      from post c
      join post s on s.id = c.quoted_post_id
      join actor a on a.id = s.actor_id
      where c.quoted_post_id is not null
        and c.visibility in ('public', 'unlisted') and c.published >= ${since}
        and ${directShare} and ${qualifyingSharerCondition}
    union
    select original.link_id
      from post c
      join post s on s.id = c.quoted_post_id
      join post original on original.id = s.shared_post_id
      join actor a on a.id = s.actor_id
      where c.quoted_post_id is not null
        and c.visibility in ('public', 'unlisted') and c.published >= ${since}
        and ${articleBoost} and ${qualifyingSharerCondition}
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
    with share_roots as (
      select
        p.link_id as link_id,
        p.id as post_id,
        p.actor_id as actor_id,
        p.published as published,
        p.reactions_count as reactions_count
      from post p
      where p.link_id is not null
        and p.visibility in ('public', 'unlisted')
        and p.shared_post_id is null${scopeFilter(scope, sql`p.link_id`)}
      union all
      select
        original.link_id as link_id,
        p.id as post_id,
        p.actor_id as actor_id,
        p.published as published,
        p.reactions_count as reactions_count
      from post p
      join post original on original.id = p.shared_post_id
      where original.type = 'Article'
        and original.link_id is not null
        and original.visibility in ('public', 'unlisted')
        and p.visibility in ('public', 'unlisted')${
    scopeFilter(scope, sql`original.link_id`)
  }
    ),
    shares as (
      select
        sr.link_id as link_id,
        sr.post_id as post_id,
        sr.published as published,
        sr.reactions_count as reactions_count,
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
          sr.published - lag(sr.published) over (
            partition by sr.actor_id, sr.link_id order by sr.published, sr.post_id
          )
        )) as gap_seconds,
        -- The promotion bonus this share's author carries as a curated preferred
        -- sharer (0 when none): folded into the link's score below.  A left join
        -- (rather than the EXISTS inside qualifyingSharerCondition) because here
        -- we need the bonus value, not just membership.
        coalesce(ps.bonus, 0::double precision) as preferred_bonus
      from share_roots sr
      join actor a on a.id = sr.actor_id
      join instance i on i.host = a.instance_host
      left join news_preferred_sharer ps on ps.actor_id = sr.actor_id
      where ${qualifyingSharerCondition}
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
        ) as weighted_mass,
        -- The strongest preferred-sharer bonus across this link's shares (0 when
        -- none).  Max, not sum: several curated sharers should not stack.
        max(s.preferred_bonus) as promotion_bonus
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
        agg.weighted_mass as weighted_mass,
        agg.promotion_bonus as promotion_bonus
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
      -- A moderator penalty overrides the preferred-sharer promotion: while
      -- score_penalty > 0 the stored bonus (and its term in score) is zeroed, so
      -- a deliberate demote/bury always wins.
      promotion_bonus =
        case when pl.score_penalty > 0 then 0::double precision
             else final.promotion_bonus end,
      recency_component =
        (extract(epoch from final.latest_activity_at) - ${NEWS_EPOCH_SECONDS}::double precision)
          / ${NEWS_TAU_SECONDS}::double precision,
      score =
        log(greatest(1::double precision, final.weighted_mass))
        + (extract(epoch from final.latest_activity_at) - ${NEWS_EPOCH_SECONDS}::double precision)
            / ${NEWS_TAU_SECONDS}::double precision
        + case when pl.score_penalty > 0 then 0::double precision
               else final.promotion_bonus end
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
      promotion_bonus = 0,
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
          and ${qualifyingSharerCondition}
      )
      and not exists (
        select 1 from post p
        join post original on original.id = p.shared_post_id
        join actor a on a.id = p.actor_id
        where original.link_id = pl.id
          and original.type = 'Article'
          and original.visibility in ('public', 'unlisted')
          and p.visibility in ('public', 'unlisted')
          and ${qualifyingSharerCondition}
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
 * Count, per link, how many of its public sharing signals come from local,
 * generic-remote, and Bluesky-bridged accounts.  A signal is a direct linked
 * post or a boost of an `Article` backed by the link.  Batched for the GraphQL
 * `PostLink.sourceBreakdown` loader; links with no public share are absent from
 * the returned map.
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
    with share_roots as (
      select p.link_id as link_id, p.actor_id as actor_id
      from post p
      where p.link_id = any(${literal}::uuid[])
        and p.visibility in ('public', 'unlisted')
        and p.shared_post_id is null
      union all
      select original.link_id as link_id, p.actor_id as actor_id
      from post p
      join post original on original.id = p.shared_post_id
      where original.link_id = any(${literal}::uuid[])
        and original.type = 'Article'
        and original.visibility in ('public', 'unlisted')
        and p.visibility in ('public', 'unlisted')
    )
    select
      sr.link_id as link_id,
      count(*) filter (where a.account_id is not null) as local,
      count(*) filter (
        where a.account_id is null and ${blueskyBridgeCondition}
      ) as bluesky,
      count(*) filter (
        where a.account_id is null and not ${blueskyBridgeCondition}
      ) as remote
    from share_roots sr
    join actor a on a.id = sr.actor_id
    join instance i on i.host = a.instance_host
    where ${qualifyingSharerCondition}
    group by sr.link_id
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
        and ${qualifyingSharerCondition}
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

// ---------------------------------------------------------------------------
// Moderation: preferred sharers
// ---------------------------------------------------------------------------

/**
 * Every link a given actor has shared (any non-boost post carrying a link, plus
 * any boost of an `Article` backed by a link, regardless of the actor's bot
 * status), so adding or removing it as a preferred sharer can rescore exactly
 * the links its whitelist and promotion affect.
 */
async function actorSharedLinkIds(
  db: Database,
  actorId: Uuid,
): Promise<Uuid[]> {
  const shares = await db.execute<{ link_id: Uuid }>(sql`
    select p.link_id as link_id
    from post p
    where p.actor_id = ${actorId}
      and p.link_id is not null
      and p.shared_post_id is null
    union
    select original.link_id as link_id
    from post p
    join post original on original.id = p.shared_post_id
    where p.actor_id = ${actorId}
      and original.type = 'Article'
      and original.link_id is not null
  `);
  return [
    ...new Set(
      shares.map((s) => s.link_id),
    ),
  ];
}

/** All preferred sharers, newest first (for the admin page). */
export function getNewsPreferredSharers(
  db: Database,
): Promise<NewsPreferredSharer[]> {
  return db
    .select()
    .from(newsPreferredSharerTable)
    .orderBy(desc(newsPreferredSharerTable.created));
}

/**
 * Curate an actor as a preferred sharer (idempotent on the actor: re-adding
 * updates its `bonus`/`note`) and enqueue a background rescore of every link it
 * has shared, so its shares are whitelisted into News and its promotion bonus is
 * applied once the worker drains the queue.  The rescore is deferred (not run
 * inline) because a high-volume feed bot can have shared far more links than fit
 * the request's statement timeout; see `drainNewsRescoreQueue`.  The actor must
 * already exist locally; the foreign key enforces it.
 */
export async function addNewsPreferredSharer(
  db: Database,
  values: {
    actorId: Uuid;
    bonus: number;
    note?: string | null;
    creatorId?: Uuid | null;
  },
): Promise<NewsPreferredSharer> {
  // A non-positive or non-finite bonus is meaningless and would poison the
  // ranking column; mirror setNewsScorePenalty's guard.
  if (!Number.isFinite(values.bonus) || values.bonus <= 0) {
    throw new RangeError(`Invalid news promotion bonus: ${values.bonus}`);
  }
  const note = values.note?.trim() || null;
  const creatorId = values.creatorId ?? null;
  const run = async (tx: Database): Promise<NewsPreferredSharer> => {
    const [row] = await tx
      .insert(newsPreferredSharerTable)
      .values({
        id: generateUuidV7(),
        actorId: values.actorId,
        bonus: values.bonus,
        note,
        creatorId,
      })
      .onConflictDoUpdate({
        target: newsPreferredSharerTable.actorId,
        set: { bonus: values.bonus, note, creatorId },
      })
      .returning();
    if (row == null) throw new Error("Failed to persist preferred sharer.");
    await enqueueNewsRescore(tx, values.actorId);
    return row;
  };
  return isTransaction(db) ? await run(db) : await db.transaction(run);
}

/**
 * Remove a preferred sharer and enqueue a background rescore of every link it
 * had shared, so a link kept in News only by its whitelist drops out and its
 * promotion bonus is cleared once the worker drains the queue.  Returns `false`
 * if no preferred sharer had that id.
 */
export async function removeNewsPreferredSharer(
  db: Database,
  id: Uuid,
): Promise<boolean> {
  const run = async (tx: Database): Promise<boolean> => {
    const [removed] = await tx
      .delete(newsPreferredSharerTable)
      .where(eq(newsPreferredSharerTable.id, id))
      .returning({ actorId: newsPreferredSharerTable.actorId });
    if (removed == null) return false;
    await enqueueNewsRescore(tx, removed.actorId);
    return true;
  };
  return isTransaction(db) ? await run(db) : await db.transaction(run);
}

// ---------------------------------------------------------------------------
// Background rescore queue
//
// Curating or un-curating a preferred sharer can change the score of every link
// that actor has ever shared.  Recomputing them inline would exceed the request
// statement timeout for a high-volume feed bot, so add/remove only enqueue the
// actor here and the worker drains it off the request path, in chunks.
// Replaceable by Fedify's general task queue (fedify-dev/fedify#206).
// ---------------------------------------------------------------------------

/**
 * Links rescored per recompute statement, kept small enough that each statement
 * stays under the production statement timeout (the periodic sweep already
 * recomputes more than this in one statement within the budget).
 */
export const NEWS_RESCORE_CHUNK_SIZE = 200;
/** Actors a single drain pass claims before yielding to the next tick. */
export const NEWS_RESCORE_MAX_ACTORS_PER_DRAIN = 50;
/**
 * Lease window (seconds): a claimed actor whose lease is older than this is
 * treated as abandoned (the worker crashed) and may be reclaimed.  A worker
 * refreshes its lease after every chunk, so this only needs to exceed one
 * chunk's recompute time (well under the statement timeout), not the whole
 * backlog's; it also bounds the retry delay after a failure or crash.
 */
export const NEWS_RESCORE_LEASE_SECONDS = 120;

/**
 * Enqueue an actor for a background News rescore (idempotent: the `actor_id` PK
 * keeps at most one row per actor).  Called when the actor is added or removed
 * as a preferred sharer.  If a row already exists, marks it `dirty` so that a
 * change landing while a worker is mid-rescore forces another pass instead of
 * being lost (the in-flight pass may have already rescored some links under the
 * old state).
 */
export async function enqueueNewsRescore(
  db: Database,
  actorId: Uuid,
): Promise<void> {
  await db
    .insert(newsRescoreQueueTable)
    .values({ actorId })
    .onConflictDoUpdate({
      target: newsRescoreQueueTable.actorId,
      set: { dirty: true },
    });
}

export interface DrainNewsRescoreQueueResult {
  /** Number of queued actors fully rescored this pass. */
  readonly actorsProcessed: number;
  /** Total links written across those actors. */
  readonly linksRecomputed: number;
}

/**
 * Drain the News rescore queue: for each claimed actor, recompute every link it
 * has shared, in chunks, off the request path.
 *
 * Concurrency: `Deno.cron` fires per worker process, so several replicas run
 * this at once.  Each claim *leases* one actor (sets `claimed_at`) with
 * `for update skip locked`, so a given actor is processed by exactly one replica
 * at a time; the worker refreshes the lease after every chunk so a long backlog
 * cannot expire mid-flight and let another replica race it on the same links.
 * Replicas claim disjoint actors and make progress in parallel, so (unlike the
 * whole-table sweep) no advisory lock is needed.
 *
 * Durability: the row is deleted only after the actor is fully rescored.  A
 * failure or crash leaves the lease in place; once it expires another pass
 * reclaims and retries the actor (the recompute is idempotent).  The catch path
 * therefore writes nothing, so it is safe even when `db` is a transaction whose
 * failing statement aborted it.  In production the worker passes the connection
 * pool; tests pass a rollback transaction, where the claim and the inline
 * recompute behave like an immediate rescore.
 *
 * Consistency under re-curation: the claim clears the `dirty` flag, so if an
 * add/remove of the same actor lands while we are processing (which only marks
 * the existing row `dirty`), the completion sees `dirty` again and reopens the
 * row for another full pass rather than deleting it, so links rescored before
 * the change are not left with stale promotion state.
 */
export async function drainNewsRescoreQueue(
  db: Database,
  options: { maxActors?: number; chunkSize?: number; leaseSeconds?: number } =
    {},
): Promise<DrainNewsRescoreQueueResult> {
  const maxActors = options.maxActors ?? NEWS_RESCORE_MAX_ACTORS_PER_DRAIN;
  const chunkSize = options.chunkSize ?? NEWS_RESCORE_CHUNK_SIZE;
  const leaseSeconds = options.leaseSeconds ?? NEWS_RESCORE_LEASE_SECONDS;
  let actorsProcessed = 0;
  let linksRecomputed = 0;
  for (let pass = 0; pass < maxActors; pass++) {
    // Lease the oldest claimable actor in one statement: unclaimed, or whose
    // lease has expired.  `for update skip locked` makes a concurrent drain skip
    // this row instead of blocking, so two replicas never lease the same actor.
    const claimed = await db.execute(sql`
      update news_rescore_queue
      set claimed_at = now(), dirty = false
      where actor_id in (
        select actor_id from news_rescore_queue
        where claimed_at is null
          or claimed_at < now() - ${leaseSeconds} * interval '1 second'
        order by enqueued
        for update skip locked
        limit 1
      )
      returning actor_id
    `) as unknown as { actor_id: Uuid }[];
    const actorId = claimed[0]?.actor_id;
    if (actorId == null) break;
    try {
      const linkIds = await actorSharedLinkIds(db, actorId);
      for (let i = 0; i < linkIds.length; i += chunkSize) {
        const { linksUpdated } = await recomputeNewsScores(db, {
          linkIds: linkIds.slice(i, i + chunkSize),
        });
        linksRecomputed += linksUpdated;
        // Refresh the lease so a long backlog cannot expire and be reclaimed by
        // another replica mid-flight.
        await db.execute(sql`
          update news_rescore_queue set claimed_at = now()
          where actor_id = ${actorId}
        `);
      }
      // Done, unless an add/remove of this actor landed mid-pass (which set
      // `dirty`): then reopen the row (clear the lease) for another full pass so
      // links rescored before the change pick up the new state; otherwise drop
      // it.
      const deleted = await db.execute(sql`
        delete from news_rescore_queue
        where actor_id = ${actorId} and dirty = false
        returning actor_id
      `) as unknown as { actor_id: Uuid }[];
      if (deleted.length < 1) {
        await db.execute(sql`
          update news_rescore_queue set claimed_at = null
          where actor_id = ${actorId}
        `);
      }
      actorsProcessed++;
    } catch (error) {
      // Leave the lease in place and stop; it expires and a later pass retries.
      // Writing nothing here keeps the catch safe for a transactional caller
      // whose failing statement aborted the transaction.
      logger.error(
        "News rescore for actor {actorId} failed; lease will retry: {error}",
        { actorId, error },
      );
      break;
    }
  }
  return { actorsProcessed, linksRecomputed };
}
