import {
  A,
  type RouteDefinition,
  useParams,
  useSearchParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createMemo, For, type JSX, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NotFoundPage } from "~/components/NotFoundPage.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Title } from "~/components/Title.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.tsx";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs.tsx";
import {
  articleAnalyticsRangeParam,
  latestAnalyticsUpdate,
  parseArticleAnalyticsRange,
  trendBarHeight,
  type ArticleAnalyticsRange,
} from "~/lib/articleAnalytics.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import type {
  analyticsArticleQuery,
  analyticsArticleQuery$data,
} from "./__generated__/analyticsArticleQuery.graphql.ts";
import type {
  analyticsDataQuery,
  analyticsDataQuery$data,
  analyticsDataQuery$variables,
} from "./__generated__/analyticsDataQuery.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

const ARTICLE_QUERY_KEY = "loadArticleAnalyticsPageArticleQuery";
const ANALYTICS_QUERY_KEY = "loadArticleAnalyticsPageQuery";

const articleQuery = graphql`
  query analyticsArticleQuery(
    $handle: String!
    $idOrYear: String!
    $slug: String!
  ) {
    articleByYearAndSlug(
      handle: $handle
      idOrYear: $idOrYear
      slug: $slug
    ) {
      sourceId
      language
      contents {
        language
        title
      }
    }
  }
`;

const analyticsQuery = graphql`
  query analyticsDataQuery(
    $articleSourceId: UUID!
    $range: ArticleAnalyticsRange!
  ) {
    articleAnalytics(articleSourceId: $articleSourceId, range: $range) {
      totalViews
      lastUpdated
      trend {
        start
        views
      }
      trendInterval
      languages {
        language
        original
        views
        share
      }
      referrers {
        category
        views
        share
      }
      externalDomains {
        domain
        views
        share
      }
      otherExternalViews
      federation {
        published
        remoteFollowers
        lastUpdated
        direct {
          attemptedServers
          acceptedServers
          pendingServers
          failedServers
          successRate
        }
        relay {
          attemptedServers
          acceptedServers
          pendingServers
          failedServers
          successRate
        }
      }
      engagement {
        replies
        shares
        quotes
        reactions
      }
    }
  }
`;

const loadArticleQuery = routePreloadedQuery(
  (handle: string, idOrYear: string, slug: string) =>
    loadQuery<analyticsArticleQuery>(
      useRelayEnvironment()(),
      articleQuery,
      { handle, idOrYear, slug },
      { fetchPolicy: "store-and-network" },
    ),
  ARTICLE_QUERY_KEY,
);

const loadAnalyticsQuery = routePreloadedQuery(
  (
    articleSourceId: analyticsDataQuery$variables["articleSourceId"],
    range: ArticleAnalyticsRange,
  ) =>
    loadQuery<analyticsDataQuery>(
      useRelayEnvironment()(),
      analyticsQuery,
      { articleSourceId, range },
      { fetchPolicy: "network-only" },
    ),
  ANALYTICS_QUERY_KEY,
);

type Article = NonNullable<analyticsArticleQuery$data["articleByYearAndSlug"]>;
type Analytics = NonNullable<analyticsDataQuery$data["articleAnalytics"]>;
type DeliveryChannel = Analytics["federation"] extends infer Federation
  ? NonNullable<Federation> extends { readonly direct: infer Direct }
    ? Direct
    : never
  : never;

interface ArticleAnalyticsLoadedProps {
  article: Article;
  sourceId: analyticsDataQuery$variables["articleSourceId"];
  articleHref: string;
}

interface ArticleAnalyticsBodyProps {
  article: Article;
  analytics: Analytics;
  range: ArticleAnalyticsRange;
  articleHref: string;
  onRangeChange: (range: ArticleAnalyticsRange) => void;
}

interface MetricCardProps {
  label: string;
  value: string;
}

interface BreakdownCardProps {
  title: string;
  description: string;
  children: JSX.Element;
}

interface BreakdownRowProps {
  label: string;
  value: string;
  share?: string;
}

interface DeliveryCardProps {
  title: string;
  channel: DeliveryChannel;
  number: (value: number) => string;
  percent: (value: number | null | undefined) => string;
}

export default function ArticleAnalyticsPage() {
  const params = useParams();
  const routeParams = createMemo(() => {
    const handle = params.handle;
    const idOrYear = params.idOrYear;
    const slug = params.slug;
    if (handle == null || idOrYear == null || slug == null) return null;
    return {
      handle: decodeRouteParam(handle),
      idOrYear,
      slug: decodeRouteParam(slug),
    };
  });
  const data = createStablePreloadedQuery<analyticsArticleQuery>(
    articleQuery,
    () => {
      const current = routeParams();
      return current == null
        ? null
        : loadArticleQuery(current.handle, current.idOrYear, current.slug);
    },
  );
  const articleHref = createMemo(() => {
    const current = routeParams();
    if (current == null) return null;
    return `/${current.handle}/${current.idOrYear}/${encodeURIComponent(current.slug)}`;
  });

  return (
    <Show keyed when={data()}>
      {(data) => (
        <Show
          keyed
          when={data.articleByYearAndSlug}
          fallback={<NotFoundPage embedded />}
        >
          {(article) => (
            <Show
              keyed
              when={article.sourceId}
              fallback={<NotFoundPage embedded />}
            >
              {(sourceId) => (
                <Show keyed when={articleHref()}>
                  {(articleHref) => (
                    <ArticleAnalyticsLoaded
                      article={article}
                      sourceId={sourceId}
                      articleHref={articleHref}
                    />
                  )}
                </Show>
              )}
            </Show>
          )}
        </Show>
      )}
    </Show>
  );
}

function ArticleAnalyticsLoaded(props: ArticleAnalyticsLoadedProps) {
  const [searchParams, setSearchParams] = useSearchParams<{ range?: string }>();
  const range = () => parseArticleAnalyticsRange(searchParams.range);
  const data = createStablePreloadedQuery<analyticsDataQuery>(
    analyticsQuery,
    () => loadAnalyticsQuery(props.sourceId, range()),
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <Show
          keyed
          when={data.articleAnalytics}
          fallback={<NotFoundPage embedded />}
        >
          {(analytics) => (
            <ArticleAnalyticsBody
              article={props.article}
              analytics={analytics}
              range={range()}
              articleHref={props.articleHref}
              onRangeChange={(nextRange) =>
                setSearchParams({
                  range: articleAnalyticsRangeParam(nextRange),
                })
              }
            />
          )}
        </Show>
      )}
    </Show>
  );
}

function ArticleAnalyticsBody(props: ArticleAnalyticsBodyProps) {
  const { i18n, t } = useLingui();
  const title = () =>
    props.article.contents.find(
      (content) => content.language === props.article.language,
    )?.title ?? props.article.contents[0]?.title;
  const latestUpdate = () =>
    latestAnalyticsUpdate(
      props.analytics.lastUpdated,
      props.analytics.federation?.lastUpdated,
    );
  const maximumViews = () =>
    Math.max(0, ...props.analytics.trend.map((point) => point.views));
  const number = (value: number) => value.toLocaleString(i18n.locale);
  const percent = (value: number | null | undefined) =>
    value == null
      ? t`Not available`
      : value.toLocaleString(i18n.locale, {
          style: "percent",
          maximumFractionDigits: 1,
        });
  const date = (value: string) =>
    new Date(`${value}T00:00:00Z`).toLocaleDateString(i18n.locale, {
      dateStyle: "medium",
      timeZone: "UTC",
    });
  const languageName = (language: string) => {
    try {
      return new Intl.DisplayNames([i18n.locale], { type: "language" }).of(
        language,
      );
    } catch {
      return language;
    }
  };
  const languageLabel = (row: Analytics["languages"][number]) => {
    if (row.language == null) return t`Other or insufficient data`;
    const name = languageName(row.language) ?? row.language;
    return row.original ? t`${name} (original)` : t`${name} (translation)`;
  };
  const referrerLabel = (
    category: Analytics["referrers"][number]["category"],
  ) => {
    switch (category) {
      case "HACKERS_PUB":
        return t`Hackers' Pub`;
      case "SEARCH":
        return t`Search engines`;
      case "FEDIVERSE":
        return t`Fediverse servers`;
      case "OTHER_EXTERNAL":
        return t`Other websites`;
      case "DIRECT_OR_UNKNOWN":
        return t`Direct or unknown`;
      default:
        return category;
    }
  };

  return (
    <NarrowContainer class="px-4 py-6 sm:py-8">
      <Title>{t`Article analytics`}</Title>
      <header class="mb-6 space-y-2">
        <A
          href={props.articleHref}
          class="text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          {t`Back to article`}
        </A>
        <h1 class="text-3xl font-bold tracking-tight">{t`Article analytics`}</h1>
        <Show when={title()}>
          <p class="text-muted-foreground">{title()}</p>
        </Show>
        <p class="text-sm text-muted-foreground">
          <Show
            keyed
            when={latestUpdate()}
            fallback={t`No analytics update has been recorded yet.`}
          >
            {(updated) => (
              <>
                {t`Last updated`} <Timestamp value={updated} />
              </>
            )}
          </Show>{" "}
          {t`Recent activity may take a few minutes to appear.`}
        </p>
      </header>

      <Tabs
        value={props.range}
        onChange={(value) =>
          props.onRangeChange(value as ArticleAnalyticsRange)
        }
        class="mb-6 overflow-x-auto"
      >
        <TabsList>
          <TabsTrigger value="SEVEN_DAYS">{t`7 days`}</TabsTrigger>
          <TabsTrigger value="THIRTY_DAYS">{t`30 days`}</TabsTrigger>
          <TabsTrigger value="NINETY_DAYS">{t`90 days`}</TabsTrigger>
          <TabsTrigger value="ALL">{t`All time`}</TabsTrigger>
        </TabsList>
      </Tabs>

      <section
        aria-label={t`Summary`}
        class="grid grid-cols-2 gap-3 sm:grid-cols-5"
      >
        <MetricCard
          label={t`Views`}
          value={number(props.analytics.totalViews)}
        />
        <MetricCard
          label={t`Replies`}
          value={number(props.analytics.engagement.replies)}
        />
        <MetricCard
          label={t`Shares`}
          value={number(props.analytics.engagement.shares)}
        />
        <MetricCard
          label={t`Quotes`}
          value={number(props.analytics.engagement.quotes)}
        />
        <MetricCard
          label={t`Reactions`}
          value={number(props.analytics.engagement.reactions)}
        />
      </section>
      <p class="mt-2 text-xs text-muted-foreground">
        {t`Views are counted reads, not unique people. Engagement totals are cumulative and do not change with the selected range.`}
      </p>

      <Card class="mt-6">
        <CardHeader>
          <CardTitle>{t`Views over time`}</CardTitle>
          <CardDescription>{t`Dates and intervals use UTC.`}</CardDescription>
        </CardHeader>
        <CardContent>
          <Show
            when={props.analytics.totalViews > 0}
            fallback={
              <p class="py-10 text-center text-sm text-muted-foreground">
                {t`No views have been counted for this range yet.`}
              </p>
            }
          >
            <div
              class="flex h-40 items-end gap-px"
              role="img"
              aria-label={t`View trend`}
            >
              <For each={props.analytics.trend}>
                {(point) => (
                  <div
                    class="min-w-0 flex-1 rounded-t-sm bg-primary/80 hover:bg-primary"
                    style={{
                      height: `${trendBarHeight(point.views, maximumViews())}%`,
                    }}
                    title={`${date(point.start)}: ${number(point.views)}`}
                  />
                )}
              </For>
            </div>
            <div class="mt-2 flex justify-between text-xs text-muted-foreground">
              <span>{date(props.analytics.trend[0]!.start)}</span>
              <span>{date(props.analytics.trend.at(-1)!.start)}</span>
            </div>
          </Show>
        </CardContent>
      </Card>

      <div class="mt-6 grid gap-6 md:grid-cols-2">
        <BreakdownCard
          title={t`Languages`}
          description={t`Language shown when the view was counted.`}
        >
          <For each={props.analytics.languages}>
            {(row) => (
              <BreakdownRow
                label={languageLabel(row)}
                value={number(row.views)}
                share={percent(row.share)}
              />
            )}
          </For>
        </BreakdownCard>
        <BreakdownCard
          title={t`Referrers`}
          description={t`Privacy-safe categories derived from the referring hostname.`}
        >
          <For each={props.analytics.referrers}>
            {(row) => (
              <BreakdownRow
                label={referrerLabel(row.category)}
                value={number(row.views)}
                share={percent(row.share)}
              />
            )}
          </For>
        </BreakdownCard>
      </div>

      <Card class="mt-6">
        <CardHeader>
          <CardTitle>{t`External websites`}</CardTitle>
          <CardDescription>
            {t`Only hostnames with enough views are shown. Paths and queries are never collected.`}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <For each={props.analytics.externalDomains}>
            {(row) => (
              <BreakdownRow
                label={row.domain}
                value={number(row.views)}
                share={percent(row.share)}
              />
            )}
          </For>
          <Show when={props.analytics.otherExternalViews > 0}>
            <BreakdownRow
              label={t`Other external websites`}
              value={number(props.analytics.otherExternalViews)}
            />
          </Show>
          <Show
            when={
              props.analytics.externalDomains.length === 0 &&
              props.analytics.otherExternalViews === 0
            }
          >
            <p class="text-sm text-muted-foreground">
              {t`No external website data is available for this range.`}
            </p>
          </Show>
        </CardContent>
      </Card>

      <Card class="mt-6">
        <CardHeader>
          <CardTitle>{t`Federation delivery`}</CardTitle>
          <CardDescription>
            {t`Delivery records whether the initial article reached a remote server, not whether anyone viewed it.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Show
            keyed
            when={props.analytics.federation}
            fallback={
              <p class="text-sm text-muted-foreground">
                {t`Delivery data is unavailable for articles published before analytics collection began.`}
              </p>
            }
          >
            {(federation) => (
              <div class="space-y-5">
                <div class="grid gap-3 sm:grid-cols-2">
                  <div>
                    <p class="text-sm text-muted-foreground">{t`Published`}</p>
                    <p class="font-medium">
                      <Timestamp value={federation.published} />
                    </p>
                  </div>
                  <div>
                    <p class="text-sm text-muted-foreground">{t`Remote followers at publication`}</p>
                    <p class="font-medium tabular-nums">
                      {number(federation.remoteFollowers)}
                    </p>
                  </div>
                </div>
                <div class="grid gap-4 md:grid-cols-2">
                  <DeliveryCard
                    title={t`Direct delivery`}
                    channel={federation.direct}
                    number={number}
                    percent={percent}
                  />
                  <DeliveryCard
                    title={t`Relay delivery`}
                    channel={federation.relay}
                    number={number}
                    percent={percent}
                  />
                </div>
                <p class="text-xs text-muted-foreground">
                  {t`Pending deliveries can change later. Counts are distinct remote servers, and the follower number is a publication-time snapshot.`}
                </p>
              </div>
            )}
          </Show>
        </CardContent>
      </Card>
    </NarrowContainer>
  );
}

function MetricCard(props: MetricCardProps) {
  return (
    <Card>
      <CardContent class="p-4">
        <p class="text-xs text-muted-foreground">{props.label}</p>
        <p class="mt-1 text-2xl font-semibold tabular-nums">{props.value}</p>
      </CardContent>
    </Card>
  );
}

function BreakdownCard(props: BreakdownCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.description}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">{props.children}</CardContent>
    </Card>
  );
}

function BreakdownRow(props: BreakdownRowProps) {
  return (
    <div class="flex items-baseline justify-between gap-4 text-sm">
      <span class="min-w-0 truncate" title={props.label}>
        {props.label}
      </span>
      <span class="shrink-0 tabular-nums">
        {props.value}
        <Show when={props.share}>
          {(share) => <span class="ml-2 text-muted-foreground">{share()}</span>}
        </Show>
      </span>
    </div>
  );
}

function DeliveryCard(props: DeliveryCardProps) {
  const { t } = useLingui();
  return (
    <div class="rounded-md border p-4">
      <h3 class="mb-3 font-medium">{props.title}</h3>
      <div class="space-y-2">
        <BreakdownRow
          label={t`Attempted servers`}
          value={props.number(props.channel.attemptedServers)}
        />
        <BreakdownRow
          label={t`Accepted`}
          value={props.number(props.channel.acceptedServers)}
        />
        <BreakdownRow
          label={t`Pending`}
          value={props.number(props.channel.pendingServers)}
        />
        <BreakdownRow
          label={t`Failed`}
          value={props.number(props.channel.failedServers)}
        />
        <BreakdownRow
          label={t`Success rate`}
          value={props.percent(props.channel.successRate)}
        />
      </div>
    </div>
  );
}
