import {
  getNewsSourceBreakdowns,
  getNewsStories,
  type NewsOrder as NewsOrderValue,
  type NewsStoriesCursor,
} from "@hackerspub/models/news";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import type { PostLink as PostLinkRow } from "@hackerspub/models/schema";
import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { createGraphQLError } from "graphql-yoga";
import { builder } from "./builder.ts";
import { Post, PostLink } from "./post.ts";

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
    "bridged accounts (`@…@bsky.brid.gy`) the least.",
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
  score: t.exposeFloat("score", {
    description:
      "Popularity-over-time rank used by the `POPULAR` feed order: " +
      "`log10(max(1, weightedMass)) + recency`.  Computed by a batch job and " +
      "refreshed incrementally; recompute is idempotent and the value is " +
      "time-stable (it changes only when the underlying posts or engagement " +
      "change, not as the clock advances).  `0` for links never shared " +
      "publicly.",
  }),
  weightedMass: t.exposeFloat("weightedMass", {
    description:
      "Recency-independent engagement mass: the weighted sum over this " +
      "link's public shares of source weight times account reputation times " +
      "(quotes, replies, reactions).  Drives the `ALL_TIME` order.",
  }),
  postCount: t.exposeInt("postCount", {
    description:
      "Number of public, non-boost posts across the fediverse that share " +
      "this link.",
  }),
  firstSharedAt: t.expose("firstSharedAt", {
    type: "DateTime",
    nullable: true,
    description:
      "When this link was first shared publicly, or `null` if it has never " +
      "been.  Drives the `NEWEST` order.",
  }),
  latestActivityAt: t.expose("latestActivityAt", {
    type: "DateTime",
    nullable: true,
    description:
      "Timestamp of the freshest activity on this link's shares (the share " +
      "itself, a reply, a quote, or a reaction).  `null` means the link is " +
      "not a news story (no public share); such links are excluded from the " +
      "feed.",
  }),
  sharingPosts: t.relatedConnection("posts", {
    type: Post,
    description:
      "The posts that share this link, most recently published first, " +
      "filtered to those visible to the viewer.  These are the roots of the " +
      "link's discussion tree.",
    query: (_args, ctx) => ({
      where: getPostVisibilityFilter(ctx.account?.actor ?? null),
      orderBy: { published: "desc" },
    }),
  }),
  sourceBreakdown: t.loadable({
    type: NewsSourceBreakdown,
    description:
      "Counts of this link's public shares by origin (local / remote / " +
      "Bluesky bridge).",
    resolve: (link) => link.id,
    load: async (linkIds: Uuid[], ctx) => {
      const breakdowns = await getNewsSourceBreakdowns(ctx.db, linkIds);
      return linkIds.map((id) =>
        breakdowns.get(id) ?? { local: 0, remote: 0, bluesky: 0 }
      );
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
