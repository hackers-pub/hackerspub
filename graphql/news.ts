import { createGraphQLError } from "graphql-yoga";
import {
  addNewsExcludedPattern,
  addNewsPreferredSharer,
  getNewsDiscussionCounts,
  getNewsExcludedPatterns,
  getNewsPenalizedStories,
  getNewsScoreStatus,
  getNewsSourceBreakdowns,
  getNewsStories,
  InvalidNewsPatternError,
  NEWS_PENALTY_BURY,
  NEWS_PENALTY_DEMOTE,
  NEWS_PROMOTE_NORMAL,
  NEWS_PROMOTE_STRONG,
  type NewsOrder as NewsOrderValue,
  newsSharerPostFilter,
  type NewsStoriesCursor,
  recomputeNewsScores,
  removeNewsExcludedPattern,
  removeNewsPreferredSharer,
  setNewsScorePenalty,
} from "@hackerspub/models/news";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import type { PostLink as PostLinkRow } from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { builder } from "./builder.ts";
import { InvalidInputError, NotAuthorizedError } from "./error.ts";
import { Article, Post, PostLink } from "./post.ts";
import { NotAuthenticatedError } from "./session.ts";

const MAX_NEWS_WINDOW = 100;

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export const NewsOrder = builder.enumType("NewsOrder", {
  description: "Ordering for the `newsStories` feed of shared links.",
  values: {
    POPULAR: {
      value: "popular",
      description:
        "Hacker-News-style score combining weighted engagement mass with " +
        "recency.  The default; what most readers want.",
    },
    NEWEST: {
      value: "newest",
      description:
        "Most recently first-shared links first, ignoring engagement.",
    },
    ALL_TIME: {
      value: "allTime",
      description:
        "Highest total weighted engagement mass first, ignoring recency: an " +
        "all-time-best view rather than what is hot right now.",
    },
  } as const,
});

// ---------------------------------------------------------------------------
// Moderator score penalty
// ---------------------------------------------------------------------------

type NewsPenaltyValue = "none" | "demote" | "bury";

export const NewsPenalty = builder.enumType("NewsPenalty", {
  description:
    "A moderator's score penalty on a news link, demoting it in the " +
    "`POPULAR` feed.  Set via `setNewsScorePenalty`; only moderators can read " +
    "or change it.  To remove a link from every order instead, exclude its " +
    "URL with a pattern (`addNewsExcludedPattern`).",
  values: {
    NONE: { value: "none", description: "No penalty." },
    DEMOTE: {
      value: "demote",
      description: "Push the link well down the popular feed.",
    },
    BURY: {
      value: "bury",
      description: "Sink the link to the bottom of the popular feed.",
    },
  } as const,
});

const PENALTY_VALUE: Record<NewsPenaltyValue, number> = {
  none: 0,
  demote: NEWS_PENALTY_DEMOTE,
  bury: NEWS_PENALTY_BURY,
};

function penaltyLevel(scorePenalty: number): NewsPenaltyValue {
  if (scorePenalty <= 0) return "none";
  if (scorePenalty >= NEWS_PENALTY_BURY) return "bury";
  return "demote";
}

// ---------------------------------------------------------------------------
// Preferred-sharer promotion
// ---------------------------------------------------------------------------

type NewsPromotionValue = "normal" | "strong";

export const NewsPromotion = builder.enumType("NewsPromotion", {
  description:
    "How strongly a `news_preferred_sharer` lifts the links it shares in the " +
    "`POPULAR` feed: a flat bonus added to the score, the mirror image of a " +
    "`NewsPenalty`.  A penalty on a link overrides the promotion.  Only " +
    "moderators set or read it.",
  values: {
    NORMAL: {
      value: "normal",
      description:
        "Reliably surface the sharer's links (roughly a month of recency " +
        "worth of score) without pinning them.",
    },
    STRONG: {
      value: "strong",
      description:
        "A larger lift for a high-signal curated feed (e.g. a Hacker News " +
        "reposter).",
    },
  } as const,
});

const PROMOTION_VALUE: Record<NewsPromotionValue, number> = {
  normal: NEWS_PROMOTE_NORMAL,
  strong: NEWS_PROMOTE_STRONG,
};

// Map a stored bonus back to the coarser level the API exposes.  Bonuses are
// only ever set from the presets above, but a threshold keeps the mapping total
// if the constants are retuned.
function promotionLevel(bonus: number): NewsPromotionValue {
  return bonus >= NEWS_PROMOTE_STRONG ? "strong" : "normal";
}

// ---------------------------------------------------------------------------
// PostLink scoring fields
// ---------------------------------------------------------------------------

const NewsSourceBreakdown = builder.simpleObject("NewsSourceBreakdown", {
  description:
    "How a link's public shares break down by origin.  Hackers' Pub posts " +
    "carry the most weight, generic remote instances less, and Bluesky-" +
    "bridged accounts (`@…@bsky.brid.gy`) the least.  Shares authored by bot " +
    "accounts (`Service`/`Application` actors) are excluded throughout, unless " +
    "the account is a curated preferred sharer.",
  fields: (t) => ({
    local: t.int({
      description: "Public shares authored by local Hackers' Pub accounts.",
    }),
    remote: t.int({
      description:
        "Public shares from generic remote fediverse instances (Mastodon, " +
        "Pleroma, etc.).",
    }),
    bluesky: t.int({
      description: "Public shares bridged from Bluesky (`@…@bsky.brid.gy`).",
    }),
  }),
});

builder.drizzleObjectFields(PostLink, (t) => ({
  uuid: t.expose("id", {
    type: "UUID",
    description:
      "The link's row UUID.  Use this for the stable discussion permalink " +
      "`/news/{uuid}`; the opaque Relay `id` is for `node(id:)` lookups.",
  }),
  score: t.exposeFloat("score", {
    description:
      "Popularity-over-time rank used by the `POPULAR` feed order: " +
      "`log10(max(1, weightedMass)) + recency + promotion - penalty`.  " +
      "Computed by a batch job and refreshed incrementally; recompute is " +
      "idempotent and the value is time-stable (it changes only when the " +
      "underlying posts, engagement, or moderator curation change, not as the " +
      "clock advances).  Shares from bot accounts (`Service`/`Application` " +
      "actors) normally never count, so a link shared only by bots stays at " +
      "`0`, as do links never shared publicly; the exception is a moderator-" +
      "curated preferred sharer, whose shares count even when it is a bot and " +
      "add a flat `promotion` bonus to the score (a moderator penalty on the " +
      "link overrides that bonus).  When one account shares the same link " +
      "repeatedly, each share after the first adds only a small, gap-dependent " +
      "fraction of the base weight (and a rapid repeat does not refresh " +
      "recency), so re-posting cannot inflate the rank.",
  }),
  weightedMass: t.exposeFloat("weightedMass", {
    description:
      "Recency-independent engagement mass: the weighted sum over this " +
      "link's public share signals (direct linked posts plus boosts of " +
      "`Article` posts backed by this link, excluding bot `Service`/" +
      "`Application` accounts unless curated as preferred sharers) of source " +
      "weight times account reputation times (quotes, replies, reactions).  " +
      "Repeated shares of the " +
      "same link by the same account add diminishing base weight (recovering " +
      "with the gap but always below a first share).  Drives the `ALL_TIME` " +
      "order.",
  }),
  postCount: t.exposeInt("postCount", {
    description:
      "Number of public share signals across the fediverse for this link: " +
      "direct linked posts plus boosts of `Article` posts backed by this " +
      "link.  Excludes shares from bot (`Service`/`Application`) accounts " +
      "that are not curated preferred sharers.  Counts every such signal, " +
      "including an account's repeated shares of the same link (a high count " +
      "with a modest `score` is expected, since repeats contribute diminishing " +
      "weight).",
  }),
  firstSharedAt: t.expose("firstSharedAt", {
    type: "DateTime",
    nullable: true,
    description:
      "When this link was first shared publicly by a qualifying account (a " +
      "non-bot account, or a curated preferred sharer), or `null` if it has " +
      "never been.  Drives the `NEWEST` order.",
  }),
  latestActivityAt: t.expose("latestActivityAt", {
    type: "DateTime",
    nullable: true,
    description:
      "Timestamp of the freshest activity on this link's qualifying shares " +
      "(the share itself, a reply, a quote, or a reaction); shares are direct " +
      "linked posts or boosts of `Article` posts backed by this link, public, " +
      "and authored by non-bot accounts (or curated preferred sharers).  A " +
      "rapid repeat share by the same " +
      "account does not refresh this (only a first share, a sufficiently-" +
      "gapped re-share, or genuine replies/quotes/reactions do), so re-posting " +
      "cannot keep a link pinned at the top.  `null` means the link is not a " +
      "news story (no qualifying public share); such links are excluded from " +
      "the feed.",
  }),
  sharingPosts: t.relatedConnection("posts", {
    type: Post,
    description:
      "The posts that share this link, most recently published first, " +
      "limited to public or unlisted posts that are visible to the viewer.  " +
      "Shares authored by bot accounts (`Service`/`Application` actors) are " +
      "excluded unless the account is a curated preferred sharer.  These are " +
      "the direct linked roots of the link's discussion tree; `Article` " +
      "boosts can also affect `score`/`postCount` but are not returned here " +
      "as roots.",
    query: (_args, ctx) => ({
      where: {
        AND: [
          { sharedPostId: { isNull: true } },
          { visibility: { in: ["public", "unlisted"] } },
          getPostVisibilityFilter(ctx.account?.actor ?? null),
          newsSharerPostFilter(),
        ],
      },
      orderBy: { published: "desc" },
    }),
  }),
  sourceBreakdown: t.loadable({
    type: NewsSourceBreakdown,
    description:
      "Counts of this link's public shares by origin (local / remote / " +
      "Bluesky bridge), including direct linked posts and boosts of `Article` " +
      "posts backed by this link.  Excludes shares from bot (`Service`/" +
      "`Application`) accounts that are not curated preferred sharers.",
    resolve: (link) => link.id,
    load: async (linkIds: Uuid[], ctx) => {
      const breakdowns = await getNewsSourceBreakdowns(ctx.db, linkIds);
      return linkIds.map((id) =>
        breakdowns.get(id) ?? { local: 0, remote: 0, bluesky: 0 }
      );
    },
  }),
  discussionCount: t.loadable({
    type: "Int",
    description:
      "Size of this link's federated discussion: its qualifying public " +
      "direct linked sharing posts (non-bot accounts, or curated preferred " +
      "sharers) plus their direct public (`public`/`unlisted`) replies and " +
      "quotes.  Use this as the count of posts to read in the discussion " +
      "(the `/news/{uuid}` page); unlike `postCount` it includes replies and " +
      "quotes, but it does not include `Article` boosts that count only toward " +
      "the score.  Counts direct children only (deeper nesting is not " +
      "traversed) and is viewer-independent (public posts only).",
    resolve: (link) => link.id,
    load: async (linkIds: Uuid[], ctx) => {
      const counts = await getNewsDiscussionCounts(ctx.db, linkIds);
      return linkIds.map((id) => counts.get(id) ?? 0);
    },
  }),
  article: t.loadable({
    type: Article,
    nullable: true,
    description:
      "The `Article` whose own URL backs this news story. `null` for ordinary " +
      "external-link stories.",
    resolve: (link) => link.id,
    async load(linkIds: Uuid[], ctx) {
      const uniqueLinkIds = [...new Set(linkIds)];
      if (uniqueLinkIds.length < 1) return [];
      const articles = await ctx.db.query.postTable.findMany({
        with: { actor: true },
        where: {
          AND: [
            { type: "Article", linkId: { in: uniqueLinkIds } },
            { sharedPostId: { isNull: true } },
            { replyTargetId: { isNull: true } },
            { quotedPostId: { isNull: true } },
            getPostVisibilityFilter(ctx.account?.actor ?? null),
          ],
        },
        orderBy: { published: "asc" },
      });
      const byLinkId = new Map<Uuid, typeof articles[number]>();
      for (const article of articles) {
        if (article.linkId == null || byLinkId.has(article.linkId)) continue;
        byLinkId.set(article.linkId, article);
      }
      return linkIds.map((id) => byLinkId.get(id) ?? null);
    },
  }),
  penalty: t.field({
    type: NewsPenalty,
    nullable: true,
    description:
      "The moderator score penalty on this link (demoting it in the " +
      "`POPULAR` feed).  `null` for non-moderators; moderators see `NONE` " +
      "when the link is unpenalized.  Set it with `setNewsScorePenalty`.",
    select: { columns: { scorePenalty: true } },
    resolve(link, _args, ctx) {
      if (ctx.session == null || !ctx.account?.moderator) return null;
      return penaltyLevel(link.scorePenalty);
    },
  }),
  promotion: t.field({
    type: NewsPromotion,
    nullable: true,
    description:
      "The preferred-sharer promotion lifting this link in the `POPULAR` " +
      "feed, or `null` when it has none (and for non-moderators).  A link is " +
      "promoted when a curated `news_preferred_sharer` shared it; a moderator " +
      "penalty suppresses the promotion, so this reads `null` while the link " +
      "is penalized.  Derived from the stored bonus.",
    select: { columns: { promotionBonus: true } },
    resolve(link, _args, ctx) {
      if (ctx.session == null || !ctx.account?.moderator) return null;
      if (link.promotionBonus <= 0) return null;
      return promotionLevel(link.promotionBonus);
    },
  }),
}));

// ---------------------------------------------------------------------------
// Feed query
// ---------------------------------------------------------------------------

function invalidNewsCursor(): never {
  throw createGraphQLError("Invalid news cursor.", {
    extensions: { code: "INVALID_CURSOR" },
  });
}

function newsWindow(first: number | null | undefined): number {
  const window = first ?? 25;
  if (window < 1) {
    throw createGraphQLError(
      "Page size must be at least 1.",
      { extensions: { code: "PAGINATION_ERROR" } },
    );
  }
  if (window > MAX_NEWS_WINDOW) {
    throw createGraphQLError(
      `News pages are limited to ${MAX_NEWS_WINDOW} stories.`,
      { extensions: { code: "PAGINATION_ERROR" } },
    );
  }
  return window;
}

function cursorScalar(link: PostLinkRow, order: NewsOrderValue): string {
  switch (order) {
    case "newest":
      return link.firstSharedAt?.toISOString() ?? "";
    case "allTime":
      return String(link.weightedMass);
    case "popular":
      return String(link.score);
  }
}

function formatNewsCursor(link: PostLinkRow, order: NewsOrderValue): string {
  return `${cursorScalar(link, order)}|${link.id}`;
}

function parseNewsCursor(
  raw: string,
  order: NewsOrderValue,
): NewsStoriesCursor {
  const i = raw.lastIndexOf("|");
  if (i < 0) invalidNewsCursor();
  const scalar = raw.slice(0, i);
  const id = raw.slice(i + 1);
  if (!validateUuid(id)) invalidNewsCursor();
  if (order === "newest") {
    const value = new Date(scalar);
    if (isNaN(value.getTime())) invalidNewsCursor();
    return { value, id: id as Uuid };
  }
  const value = Number(scalar);
  if (!Number.isFinite(value)) invalidNewsCursor();
  return { value, id: id as Uuid };
}

builder.queryField("newsStories", (t) =>
  t.connection({
    type: PostLink,
    description:
      "Links shared across the fediverse, ranked as a news feed.  Forward " +
      "pagination only (`first`/`after`); `last`/`before` raise a " +
      "`PAGINATION_ERROR`.  Pages are capped at " +
      `${MAX_NEWS_WINDOW} stories.  No authentication required.`,
    args: {
      order: t.arg({
        type: NewsOrder,
        defaultValue: "popular",
        description: "How to rank the feed.  Defaults to `POPULAR`.",
      }),
    },
    async resolve(_, args, ctx) {
      if (args.before != null || args.last != null) {
        throw createGraphQLError(
          "The news feed supports forward pagination only.",
          { extensions: { code: "PAGINATION_ERROR" } },
        );
      }
      const order = args.order as NewsOrderValue;
      const window = newsWindow(args.first);
      const after = args.after == null
        ? undefined
        : parseNewsCursor(args.after, order);
      const stories = await getNewsStories(ctx.db, {
        order,
        limit: window + 1,
        after,
      });
      const hasNextPage = stories.length > window;
      const page = stories.slice(0, window);
      return {
        pageInfo: {
          hasNextPage,
          hasPreviousPage: args.after != null,
          startCursor: page.length < 1
            ? null
            : formatNewsCursor(page[0], order),
          endCursor: page.length < 1
            ? null
            : formatNewsCursor(page[page.length - 1], order),
        },
        edges: page.map((link) => ({
          node: link,
          cursor: formatNewsCursor(link, order),
        })),
      };
    },
  }));

builder.queryField("newsStory", (t) =>
  t.drizzleField({
    type: PostLink,
    nullable: true,
    description:
      "Look up a news story (a shared link) by its row UUID, for the " +
      "discussion permalink `/news/{uuid}`.  Returns `null` for a malformed " +
      "id, or for a link that is not a public news story: only links with a " +
      "qualifying public share (`latestActivityAt` is not `null`) resolve, so " +
      "a link seen only in followers-only or direct posts stays private.  A " +
      "link hidden from the feed by an exclusion pattern (`excludedFromNews`) " +
      "is still reachable here.",
    args: {
      id: t.arg({
        type: "UUID",
        required: true,
        description:
          "The link's row UUID (`PostLink.uuid`), as embedded in the " +
          "`/news/{uuid}` permalink.",
      }),
    },
    resolve(query, _root, args, ctx) {
      if (!validateUuid(args.id)) return null;
      return ctx.db.query.postLinkTable.findFirst(
        query({
          where: { id: args.id, latestActivityAt: { isNotNull: true } },
        }),
      );
    },
  }));

// ---------------------------------------------------------------------------
// Admin: status + manual recompute
// ---------------------------------------------------------------------------

const NewsScoreStatus = builder.simpleObject("NewsScoreStatus", {
  description:
    "A snapshot of news scoring state, for the moderator admin page.",
  fields: (t) => ({
    scoredLinkCount: t.int({
      description:
        "Number of links currently in the feed (with at least one public " +
        "share).",
    }),
    lastRecomputedAt: t.field({
      type: "DateTime",
      nullable: true,
      description: "When scores were last recomputed, or `null` if never.",
    }),
  }),
});

builder.queryField("newsScoreStatus", (t) =>
  t.field({
    type: NewsScoreStatus,
    nullable: true,
    description:
      "Moderator-only news scoring snapshot.  Returns `null` when the viewer " +
      "is not a moderator; routes should guard with `viewer.moderator`.",
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;
      return await getNewsScoreStatus(ctx.db);
    },
  }));

const RecomputeNewsScoresPayload = builder.simpleObject(
  "RecomputeNewsScoresPayload",
  {
    description: "The result of a full news score recompute.",
    fields: (t) => ({
      linksUpdated: t.int({
        description:
          "Number of links with at least one qualifying public share that " +
          "were (re)scored by this run.  Stale links dropped from the feed " +
          "(they lost their last public share) are reset to zero but not " +
          "counted here.",
      }),
      recomputedAt: t.field({
        type: "DateTime",
        description: "When the recompute ran.",
      }),
      status: t.field({
        type: NewsScoreStatus,
        description: "The scoring status after the run.",
      }),
    }),
  },
);

builder.mutationField("recomputeNewsScores", (t) =>
  t.field({
    type: RecomputeNewsScoresPayload,
    description:
      "Recompute popularity scores for every news link.  Requires a " +
      "moderator account.  Idempotent: safe to trigger at any time, and " +
      "running it twice on unchanged data yields identical scores.  Normally " +
      "scores stay fresh on their own (incrementally on share, plus a " +
      "periodic sweep); this is the manual full rebuild and dev backstop.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError],
    },
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const result = await recomputeNewsScores(ctx.db);
      const status = await getNewsScoreStatus(ctx.db);
      return {
        linksUpdated: result.linksUpdated,
        recomputedAt: result.recomputedAt,
        status,
      };
    },
  }));

// ---------------------------------------------------------------------------
// Admin: per-link score penalty
// ---------------------------------------------------------------------------

builder.mutationField("setNewsScorePenalty", (t) =>
  t.field({
    type: PostLink,
    nullable: true,
    description:
      "Set (or clear with `NONE`) a moderator score penalty on a news link, " +
      "demoting it in the `POPULAR` feed.  Requires a moderator account.  " +
      "Returns the updated link, or `null` if no link has that id.",
    errors: { types: [NotAuthenticatedError, NotAuthorizedError] },
    args: {
      id: t.arg({
        type: "UUID",
        required: true,
        description: "The link's row UUID (`PostLink.uuid`).",
      }),
      penalty: t.arg({
        type: NewsPenalty,
        required: true,
        description: "The penalty level to apply (`NONE` clears it).",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const link = await ctx.db.query.postLinkTable.findFirst({
        where: { id: args.id },
      });
      if (link == null) return null;
      await setNewsScorePenalty(ctx.db, args.id, PENALTY_VALUE[args.penalty]);
      return await ctx.db.query.postLinkTable.findFirst({
        where: { id: args.id },
      }) ?? null;
    },
  }));

builder.queryField("newsPenalizedStories", (t) =>
  t.field({
    type: [PostLink],
    nullable: true,
    description:
      "Moderator-only list of news links currently carrying a score penalty, " +
      "heaviest first, for reviewing/clearing demotions (a buried link is no " +
      "longer near the top of the feed).  `null` for non-moderators.",
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;
      return await getNewsPenalizedStories(ctx.db);
    },
  }));

// ---------------------------------------------------------------------------
// Admin: URL exclusion patterns
// ---------------------------------------------------------------------------

const NewsExcludedPattern = builder.simpleObject("NewsExcludedPattern", {
  description:
    "A moderator-managed `URLPattern` string; links whose URL matches it are " +
    "hidden from the news feed list (every sort order).  Their discussion " +
    "page stays reachable by direct link.",
  fields: (t) => ({
    id: t.field({ type: "UUID", description: "The pattern's row UUID." }),
    pattern: t.string({
      description: "The `URLPattern` string, e.g. `https://example.com/*` or " +
        "`https://*.example.com/*`.",
    }),
    note: t.string({
      nullable: true,
      description: "An optional moderator note explaining the exclusion.",
    }),
    created: t.field({
      type: "DateTime",
      description: "When the pattern was added.",
    }),
  }),
});

builder.queryField("newsExcludedPatterns", (t) =>
  t.field({
    type: [NewsExcludedPattern],
    nullable: true,
    description:
      "Moderator-only list of news feed exclusion patterns, newest first.  " +
      "`null` for non-moderators.",
    async resolve(_root, _args, ctx) {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;
      const rows = await getNewsExcludedPatterns(ctx.db);
      return rows.map((row) => ({
        id: row.id,
        pattern: row.pattern,
        note: row.note,
        created: row.created,
      }));
    },
  }));

builder.mutationField("addNewsExcludedPattern", (t) =>
  t.field({
    type: NewsExcludedPattern,
    description:
      "Add a news feed exclusion pattern (a `URLPattern` string) and hide " +
      "matching links from the feed list.  Idempotent on the pattern string.  " +
      "Requires a moderator account.  An invalid pattern raises " +
      "`InvalidInputError`.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    args: {
      pattern: t.arg.string({
        required: true,
        description:
          "The `URLPattern` string to exclude, e.g. `https://example.com/*`.",
      }),
      note: t.arg.string({
        description: "An optional note explaining the exclusion.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      try {
        const row = await addNewsExcludedPattern(ctx.db, {
          pattern: args.pattern,
          note: args.note ?? null,
          creatorId: ctx.account.id,
        });
        return {
          id: row.id,
          pattern: row.pattern,
          note: row.note,
          created: row.created,
        };
      } catch (error) {
        if (error instanceof InvalidNewsPatternError) {
          throw new InvalidInputError("pattern");
        }
        throw error;
      }
    },
  }));

const RemoveNewsExcludedPatternPayload = builder.simpleObject(
  "RemoveNewsExcludedPatternPayload",
  {
    description: "The result of removing a news feed exclusion pattern.",
    fields: (t) => ({
      removedId: t.field({
        type: "UUID",
        nullable: true,
        description:
          "The removed pattern's id, or `null` if no pattern had that id.",
      }),
    }),
  },
);

builder.mutationField("removeNewsExcludedPattern", (t) =>
  t.field({
    type: RemoveNewsExcludedPatternPayload,
    description:
      "Remove a news feed exclusion pattern by id, un-hiding links it no " +
      "longer matches.  Requires a moderator account.",
    errors: { types: [NotAuthenticatedError, NotAuthorizedError] },
    args: {
      id: t.arg({
        type: "UUID",
        required: true,
        description: "The pattern's row UUID.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const removed = await removeNewsExcludedPattern(ctx.db, args.id);
      return { removedId: removed ? args.id : null };
    },
  }));

// ---------------------------------------------------------------------------
// Admin: preferred sharers
// ---------------------------------------------------------------------------

const NewsPreferredSharer = builder.drizzleObject("newsPreferredSharerTable", {
  name: "NewsPreferredSharer",
  description:
    "A moderator-curated actor whose shares are favored in the News feed: its " +
    "shares count even when it is a bot (`Service`/`Application`) actor that " +
    "would otherwise be excluded, and the links it shares get a flat " +
    "`promotion` bonus in the `POPULAR` order.  Managed via " +
    "`addNewsPreferredSharer`/`removeNewsPreferredSharer`; only moderators can " +
    "read or change it.",
  fields: (t) => ({
    id: t.expose("id", {
      type: "UUID",
      description:
        "The curation row's UUID; pass it to `removeNewsPreferredSharer`.",
    }),
    actor: t.relation("actor", {
      description: "The curated actor whose shares are favored.",
    }),
    promotion: t.field({
      type: NewsPromotion,
      description: "How strongly this sharer's links are lifted.",
      select: { columns: { bonus: true } },
      resolve: (sharer) => promotionLevel(sharer.bonus),
    }),
    note: t.exposeString("note", {
      nullable: true,
      description: "An optional moderator note explaining the curation.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When the sharer was curated.",
    }),
  }),
});

builder.queryField("newsPreferredSharers", (t) =>
  t.drizzleField({
    type: [NewsPreferredSharer],
    nullable: true,
    description:
      "Moderator-only list of curated preferred sharers, newest first.  " +
      "`null` for non-moderators.",
    async resolve(query, _root, _args, ctx) {
      if (ctx.session == null) return null;
      if (!ctx.account?.moderator) return null;
      return await ctx.db.query.newsPreferredSharerTable.findMany(
        query({ orderBy: { created: "desc" } }),
      );
    },
  }));

builder.mutationField("addNewsPreferredSharer", (t) =>
  t.field({
    type: NewsPreferredSharer,
    description:
      "Curate an actor as a preferred sharer (idempotent on the actor: " +
      "re-adding updates its promotion and note) and rescore every link it " +
      "has shared, whitelisting its shares into News and applying the " +
      "promotion at once.  Requires a moderator account.  Raises " +
      "`InvalidInputError` if no actor has that id.",
    errors: {
      types: [NotAuthenticatedError, NotAuthorizedError, InvalidInputError],
    },
    args: {
      actorId: t.arg({
        type: "UUID",
        required: true,
        description:
          "The curated actor's row UUID (`Actor.uuid`), e.g. resolved from a " +
          "handle via `actorByHandle`.",
      }),
      promotion: t.arg({
        type: NewsPromotion,
        defaultValue: "normal",
        description:
          "How strongly to lift the sharer's links.  Defaults to `NORMAL`.",
      }),
      note: t.arg.string({
        description: "An optional note explaining the curation.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const actor = await ctx.db.query.actorTable.findFirst({
        where: { id: args.actorId },
        columns: { id: true },
      });
      if (actor == null) throw new InvalidInputError("actorId");
      // `promotion` carries a default but is still nullable, so an explicit
      // `null` reaches here; fall back to the default rather than indexing
      // `PROMOTION_VALUE` with `null` (which would throw a bare `RangeError`).
      const promotion = (args.promotion ?? "normal") as NewsPromotionValue;
      return await addNewsPreferredSharer(ctx.db, {
        actorId: args.actorId,
        bonus: PROMOTION_VALUE[promotion],
        note: args.note ?? null,
        creatorId: ctx.account.id,
      });
    },
  }));

const RemoveNewsPreferredSharerPayload = builder.simpleObject(
  "RemoveNewsPreferredSharerPayload",
  {
    description: "The result of removing a preferred sharer.",
    fields: (t) => ({
      removedId: t.field({
        type: "UUID",
        nullable: true,
        description:
          "The removed curation row's id, or `null` if none had that id.",
      }),
    }),
  },
);

builder.mutationField("removeNewsPreferredSharer", (t) =>
  t.field({
    type: RemoveNewsPreferredSharerPayload,
    description:
      "Remove a preferred sharer by id and rescore every link it had shared, " +
      "so a link kept in News only by its whitelist drops out and its " +
      "promotion is cleared.  Requires a moderator account.",
    errors: { types: [NotAuthenticatedError, NotAuthorizedError] },
    args: {
      id: t.arg({
        type: "UUID",
        required: true,
        description: "The curation row's UUID (`NewsPreferredSharer.id`).",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.session == null) throw new NotAuthenticatedError();
      if (!ctx.account?.moderator) throw new NotAuthorizedError();
      const removed = await removeNewsPreferredSharer(ctx.db, args.id);
      return { removedId: removed ? args.id : null };
    },
  }));
