import {
  type ArticleAnalyticsRange as ArticleAnalyticsRangeValue,
  canViewArticleAnalytics,
  getArticleSupplementalAnalytics,
  getArticleViewAnalytics,
  recordArticleView,
} from "@hackerspub/models/article-analytics";
import { builder } from "./builder.ts";

const ArticleAnalyticsRange = builder.enumType("ArticleAnalyticsRange", {
  description:
    "UTC calendar range used for private article analytics. The selected " +
    "range includes the current UTC day.",
  values: {
    SEVEN_DAYS: {
      value: "seven_days" satisfies ArticleAnalyticsRangeValue,
      description: "The current UTC day and the preceding 6 days.",
    },
    THIRTY_DAYS: {
      value: "thirty_days" satisfies ArticleAnalyticsRangeValue,
      description: "The current UTC day and the preceding 29 days.",
    },
    NINETY_DAYS: {
      value: "ninety_days" satisfies ArticleAnalyticsRangeValue,
      description: "The current UTC day and the preceding 89 days.",
    },
    ALL: {
      value: "all" satisfies ArticleAnalyticsRangeValue,
      description:
        "All views collected since article analytics became available. " +
        "Views from before collection began are not backfilled.",
    },
  } as const,
});

const ArticleAnalyticsTrendInterval = builder.enumType(
  "ArticleAnalyticsTrendInterval",
  {
    description:
      "UTC calendar interval used for a trend point. Longer ranges use " +
      "coarser intervals so a trend contains at most 90 points.",
    values: {
      DAY: { value: "day", description: "One UTC calendar day." },
      WEEK: {
        value: "week",
        description: "One UTC week beginning on Monday.",
      },
      MONTH: { value: "month", description: "One UTC calendar month." },
      YEAR: { value: "year", description: "One UTC calendar year." },
    } as const,
  },
);

const ArticleAnalyticsReferrerCategory = builder.enumType(
  "ArticleAnalyticsReferrerCategory",
  {
    description:
      "Privacy-preserving source category derived from a referrer's " +
      "hostname. Full referrer URLs are never accepted or stored.",
    values: {
      HACKERS_PUB: {
        value: "hackers_pub",
        description: "Navigation from this Hackers' Pub instance.",
      },
      SEARCH: {
        value: "search",
        description: "Navigation from an allowlisted search engine.",
      },
      FEDIVERSE: {
        value: "fediverse",
        description:
          "Navigation from a hostname already known as a fediverse instance.",
      },
      OTHER_EXTERNAL: {
        value: "other_external",
        description:
          "Navigation from another external hostname that is not classified " +
          "as search or fediverse traffic.",
      },
      DIRECT_OR_UNKNOWN: {
        value: "direct_or_unknown",
        description:
          "A missing, invalid, IP-literal, or otherwise unknown referrer.",
      },
    } as const,
  },
);

const ArticleAnalyticsTrendPoint = builder.simpleObject(
  "ArticleAnalyticsTrendPoint",
  {
    description: "One UTC-aligned point in an article view trend.",
    fields: (t) => ({
      start: t.field({
        type: "Date",
        description:
          "First UTC date in this point's day, week, month, or year.",
      }),
      views: t.int({
        description: "Counted article views in this interval.",
      }),
    }),
  },
);

const ArticleAnalyticsLanguage = builder.simpleObject(
  "ArticleAnalyticsLanguage",
  {
    description:
      "Views of one displayed language version, classified at view time. " +
      "Rows with fewer than 3 views are combined into one protected row.",
    fields: (t) => ({
      language: t.field({
        type: "Locale",
        nullable: true,
        description:
          "Displayed BCP 47 language, or `null` for the combined " +
          "other/insufficient-data row.",
      }),
      original: t.boolean({
        nullable: true,
        description:
          "Whether this was original content rather than a translation, or " +
          "`null` for the combined protected row.",
      }),
      views: t.int({
        description:
          "Counted views. The protected row includes every language/original " +
          "combination below the 3-view threshold.",
      }),
      share: t.float({
        description:
          "This row's share of selected-range views from `0` through `1`.",
      }),
    }),
  },
);

const ArticleAnalyticsReferrer = builder.simpleObject(
  "ArticleAnalyticsReferrer",
  {
    description: "Counted article views in one privacy-safe referrer category.",
    fields: (t) => ({
      category: t.field({
        type: ArticleAnalyticsReferrerCategory,
        description: "Server-derived referrer category.",
      }),
      views: t.int({
        description: "Counted views attributed to this category.",
      }),
      share: t.float({
        description:
          "This category's share of selected-range views from `0` through `1`.",
      }),
    }),
  },
);

const ArticleAnalyticsExternalDomain = builder.simpleObject(
  "ArticleAnalyticsExternalDomain",
  {
    description:
      "A normalized external referrer hostname with at least 3 views in the " +
      "selected range. At most the 10 highest-volume domains are returned.",
    fields: (t) => ({
      domain: t.string({
        description:
          "Lowercase ASCII hostname after presentation prefixes such as " +
          "`www` and `m` are removed. Never contains a URL path or query.",
      }),
      views: t.int({ description: "Counted views from this hostname." }),
      share: t.float({
        description:
          "This hostname's share of all selected-range views from `0` " +
          "through `1`.",
      }),
    }),
  },
);

const ArticleAnalyticsDeliveryChannel = builder.simpleObject(
  "ArticleAnalyticsDeliveryChannel",
  {
    description:
      "Distinct remote-server delivery outcomes for one channel. A server is " +
      "`accepted` if any message succeeded, otherwise `pending` if any " +
      "message remains pending, and `failed` only when every message failed.",
    fields: (t) => ({
      attemptedServers: t.int({
        description:
          "Distinct remote servers with an attempted initial Article " +
          "`Create` delivery.",
      }),
      acceptedServers: t.int({
        description:
          "Distinct attempted servers that accepted at least one delivery.",
      }),
      pendingServers: t.int({
        description:
          "Distinct attempted servers with no accepted delivery and at " +
          "least one delivery still pending.",
      }),
      failedServers: t.int({
        description:
          "Distinct attempted servers whose deliveries all failed permanently.",
      }),
      successRate: t.float({
        nullable: true,
        description:
          "`acceptedServers` divided by `attemptedServers`, or `null` when " +
          "no remote server was attempted. This measures delivery, not reach.",
      }),
    }),
  },
);

const ArticleAnalyticsFederation = builder.simpleObject(
  "ArticleAnalyticsFederation",
  {
    description:
      "Federation snapshot for the article's initial `Create`. Server " +
      "identifiers are hashed and never exposed; updates are not included.",
    fields: (t) => ({
      published: t.field({
        type: "DateTime",
        description: "When the local article was initially published.",
      }),
      remoteFollowers: t.int({
        description:
          "Accepted remote followers of the article author at publication " +
          "time. This is a snapshot, not a delivered or reached audience.",
      }),
      direct: t.field({
        type: ArticleAnalyticsDeliveryChannel,
        description:
          "Initial `Create` deliveries sent directly to follower servers.",
      }),
      relay: t.field({
        type: ArticleAnalyticsDeliveryChannel,
        description:
          "Initial `Create` deliveries sent to accepted generic relays or " +
          "the eligible tags.pub relay.",
      }),
      lastUpdated: t.field({
        type: "DateTime",
        description:
          "Latest publication or delivery-status update represented here.",
      }),
    }),
  },
);

const ArticleAnalyticsEngagement = builder.simpleObject(
  "ArticleAnalyticsEngagement",
  {
    description:
      "Current cumulative engagement counters for the local Article post. " +
      "These counts are not filtered by the selected view range.",
    fields: (t) => ({
      replies: t.int({ description: "Current reply count." }),
      shares: t.int({ description: "Current share count." }),
      quotes: t.int({ description: "Current quote count." }),
      reactions: t.int({ description: "Current reaction count." }),
    }),
  },
);

const ArticleAnalytics = builder.simpleObject("ArticleAnalytics", {
  description:
    "Private analytics for one source-backed local `Article`. Only its " +
    "personal author or an accepted member of its organization author can " +
    "read this snapshot. Moderators receive no automatic access.",
  fields: (t) => ({
    range: t.field({
      type: ArticleAnalyticsRange,
      description:
        "Range represented by every view aggregate in this snapshot.",
    }),
    from: t.field({
      type: "Date",
      nullable: true,
      description:
        "First UTC date in a fixed range, or `null` when `range` is `ALL`.",
    }),
    to: t.field({
      type: "Date",
      description: "Current UTC date and inclusive end of the selected range.",
    }),
    totalViews: t.int({
      description:
        "Counted reads in the selected range after 2-second client eligibility " +
        "and 30-minute token deduplication. This is not a unique-person count.",
    }),
    trendInterval: t.field({
      type: ArticleAnalyticsTrendInterval,
      description: "Calendar interval used by `trend`.",
    }),
    trend: t.field({
      type: [ArticleAnalyticsTrendPoint],
      description:
        "Zero-filled UTC view trend with at most 90 points, ordered oldest first.",
    }),
    languages: t.field({
      type: [ArticleAnalyticsLanguage],
      description:
        "Displayed-language breakdown. Every row below 3 views is combined " +
        "so returned counts still sum to `totalViews`.",
    }),
    referrers: t.field({
      type: [ArticleAnalyticsReferrer],
      description:
        "Five server-derived referrer categories, including zero-count rows.",
    }),
    externalDomains: t.field({
      type: [ArticleAnalyticsExternalDomain],
      description:
        "Up to 10 external hostnames with at least 3 selected-range views, " +
        "ordered by views and then hostname.",
    }),
    otherExternalViews: t.int({
      description:
        "External views hidden by the 3-view threshold, the top-10 limit, or " +
        "the per-article daily domain-cardinality cap. Add this to " +
        "`externalDomains.views` to recover the `OTHER_EXTERNAL` category " +
        "total.",
    }),
    lastUpdated: t.field({
      type: "DateTime",
      nullable: true,
      description:
        "When a view aggregate for this article was most recently updated, " +
        "or `null` before its first counted view.",
    }),
    federation: t.field({
      type: ArticleAnalyticsFederation,
      nullable: true,
      description:
        "Initial federation delivery snapshot, or `null` when the article " +
        "predates collection or no publication snapshot was recorded.",
    }),
    engagement: t.field({
      type: ArticleAnalyticsEngagement,
      description:
        "Current engagement counts. Unlike view fields, these are cumulative " +
        "and do not change with `range`.",
    }),
  }),
});

const RecordArticleViewPayload = builder.simpleObject(
  "RecordArticleViewPayload",
  {
    description:
      "Result of a best-effort article view record attempt. Rejected, " +
      "duplicate, editor, and identifiable-bot views return `false`.",
    fields: (t) => ({
      counted: t.boolean({
        description: "Whether this request incremented the article aggregates.",
      }),
    }),
  },
);

builder.queryField("articleAnalytics", (t) =>
  t.field({
    type: ArticleAnalytics,
    nullable: true,
    description:
      "Read private analytics for a source-backed local article. Returns " +
      "`null` without authentication, for an unknown source, or when the " +
      "viewer is neither the personal author, an accepted member of the " +
      "organization author, nor a moderator.",
    args: {
      articleSourceId: t.arg({
        type: "UUID",
        required: true,
        description:
          "Stable local source UUID from `Article.sourceId`; slug changes do " +
          "not change this identifier.",
      }),
      range: t.arg({
        type: ArticleAnalyticsRange,
        required: false,
        defaultValue: "thirty_days",
        description: "UTC calendar range to aggregate. Defaults to 30 days.",
      }),
    },
    async resolve(_root, args, ctx) {
      if (ctx.account == null) return null;
      if (
        !(await canViewArticleAnalytics(ctx.db, args.articleSourceId, {
          accountId: ctx.account.id,
          moderator: ctx.account.moderator,
        }))
      ) {
        return null;
      }
      const [views, supplemental] = await Promise.all([
        getArticleViewAnalytics(
          ctx.db,
          args.articleSourceId,
          args.range ?? "thirty_days",
        ),
        getArticleSupplementalAnalytics(ctx.db, args.articleSourceId),
      ]);
      return { ...views, ...supplemental };
    },
  }),
);

builder.mutationField("recordArticleView", (t) =>
  t.field({
    type: RecordArticleViewPayload,
    description:
      "Record an eligible source-backed local article read. Clients should " +
      "call this only after the article has remained visible in a focused " +
      "page for 2 continuous seconds. The server excludes identifiable bots " +
      "and signed-in editors, then deduplicates the opaque per-article token " +
      "for 30 minutes. No IP address or browser fingerprint is stored.",
    args: {
      articleSourceId: t.arg({
        type: "UUID",
        required: true,
        description: "Stable local source UUID from `Article.sourceId`.",
      }),
      language: t.arg({
        type: "Locale",
        required: true,
        description:
          "Language version actually displayed when eligibility completed. " +
          "The server verifies that this version exists and derives its " +
          "original/translation status from stored content.",
      }),
      visitorToken: t.arg.string({
        required: true,
        description:
          "Opaque random token scoped to this article. It is hashed before " +
          "storage and used only for best-effort 30-minute deduplication; it " +
          "must not encode an IP address or browser fingerprint.",
      }),
      referrerHostname: t.arg.string({
        required: false,
        description:
          "Hostname from the browser referrer, without scheme, user info, " +
          "port, path, query, or fragment. Omit when no valid hostname is " +
          "available; full URLs must never be sent.",
      }),
    },
    async resolve(_root, args, ctx) {
      const counted = await recordArticleView(ctx.db, {
        articleSourceId: args.articleSourceId,
        language: args.language.baseName,
        referrerHostname: args.referrerHostname ?? null,
        canonicalHostname: new URL(ctx.fedCtx.canonicalOrigin).hostname,
        visitorToken: args.visitorToken,
        viewerAccountId: ctx.account?.id,
        userAgent: ctx.request.headers.get("user-agent"),
      });
      return { counted };
    },
  }),
);
