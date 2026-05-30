import {
  getNewsDiscussionCounts,
  getNewsScoreStatus,
  getNewsSourceBreakdowns,
  getNewsStories,
  NEWS_BOT_ACTOR_TYPES,
  type NewsOrder as NewsOrderValue,
  type NewsStoriesCursor,
  recomputeNewsScores,
} from "@hackerspub/models/news";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import type { PostLink as PostLinkRow } from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { createGraphQLError } from "graphql-yoga";
import { builder } from "./builder.ts";
import { NotAuthorizedError } from "./error.ts";
import { Post, PostLink } from "./post.ts";
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
// PostLink scoring fields
// ---------------------------------------------------------------------------

const NewsSourceBreakdown = builder.simpleObject("NewsSourceBreakdown", {
  description:
    "How a link's public shares break down by origin.  Hackers' Pub posts " +
    "carry the most weight, generic remote instances less, and Bluesky-" +
    "bridged accounts (`@…@bsky.brid.gy`) the least.  Shares authored by bot " +
    "accounts (`Service`/`Application` actors) are excluded throughout.",
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
      "`log10(max(1, weightedMass)) + recency`.  Computed by a batch job and " +
      "refreshed incrementally; recompute is idempotent and the value is " +
      "time-stable (it changes only when the underlying posts or engagement " +
      "change, not as the clock advances).  Shares from bot accounts " +
      "(`Service`/`Application` actors) never count, so a link shared only by " +
      "bots stays at `0`, as do links never shared publicly.  When one account " +
      "shares the same link repeatedly, each share after the first adds only a " +
      "small, gap-dependent fraction of the base weight (and a rapid repeat " +
      "does not refresh recency), so re-posting cannot inflate the rank.",
  }),
  weightedMass: t.exposeFloat("weightedMass", {
    description:
      "Recency-independent engagement mass: the weighted sum over this " +
      "link's public shares (excluding bot `Service`/`Application` accounts) " +
      "of source weight times account reputation times (quotes, replies, " +
      "reactions).  Repeated shares of the same link by the same account add " +
      "diminishing base weight (recovering with the gap but always below a " +
      "first share).  Drives the `ALL_TIME` order.",
  }),
  postCount: t.exposeInt("postCount", {
    description:
      "Number of public, non-boost posts across the fediverse that share " +
      "this link, excluding shares from bot (`Service`/`Application`) " +
      "accounts.  Counts every such post, including an account's repeated " +
      "shares of the same link (a high count with a modest `score` is " +
      "expected, since repeats contribute diminishing weight).",
  }),
  firstSharedAt: t.expose("firstSharedAt", {
    type: "DateTime",
    nullable: true,
    description:
      "When this link was first shared publicly by a non-bot account, or " +
      "`null` if it has never been.  Drives the `NEWEST` order.",
  }),
  latestActivityAt: t.expose("latestActivityAt", {
    type: "DateTime",
    nullable: true,
    description:
      "Timestamp of the freshest activity on this link's qualifying shares " +
      "(the share itself, a reply, a quote, or a reaction); shares are public " +
      "and authored by non-bot accounts.  A rapid repeat share by the same " +
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
      "filtered to those visible to the viewer.  Shares authored by bot " +
      "accounts (`Service`/`Application` actors) are excluded, matching the " +
      "scoring.  These are the roots of the link's discussion tree.",
    query: (_args, ctx) => ({
      where: {
        AND: [
          getPostVisibilityFilter(ctx.account?.actor ?? null),
          { actor: { type: { notIn: [...NEWS_BOT_ACTOR_TYPES] } } },
        ],
      },
      orderBy: { published: "desc" },
    }),
  }),
  sourceBreakdown: t.loadable({
    type: NewsSourceBreakdown,
    description:
      "Counts of this link's public shares by origin (local / remote / " +
      "Bluesky bridge), excluding shares from bot (`Service`/`Application`) " +
      "accounts.",
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
      "Size of this link's federated discussion: its non-bot public sharing " +
      "posts plus their direct public (`public`/`unlisted`) replies and " +
      "quotes.  Use this as the count of posts to read in the discussion " +
      "(the `/news/{uuid}` page); unlike `postCount` it includes the replies " +
      "and quotes, not just the shares.  Counts direct children only (deeper " +
      "nesting is not traversed) and is viewer-independent (public posts " +
      "only).",
    resolve: (link) => link.id,
    load: async (linkIds: Uuid[], ctx) => {
      const counts = await getNewsDiscussionCounts(ctx.db, linkIds);
      return linkIds.map((id) => counts.get(id) ?? 0);
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
      "id or a link that does not exist.  The link need not currently be in " +
      "the feed.",
    args: {
      id: t.arg({ type: "UUID", required: true }),
    },
    resolve(query, _root, args, ctx) {
      if (!validateUuid(args.id)) return null;
      return ctx.db.query.postLinkTable.findFirst(
        query({ where: { id: args.id } }),
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
