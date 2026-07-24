import { Title } from "@solidjs/meta";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { NewsList } from "~/components/NewsList.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import {
  getTimelinePageQueryLoadOptions,
  TIMELINE_PAGE_QUERY_CACHE_KEYS,
} from "~/lib/timelinePageQueryCache.ts";
import { type NewsSort, useNewsSort } from "~/lib/useNewsSort.ts";
import type { newsPageQuery } from "./__generated__/newsPageQuery.graphql.ts";

const newsPageQuery = graphql`
  query newsPageQuery($order: NewsOrder) {
    ...NewsList_stories @arguments(order: $order)
  }
`;

const loadNewsPageQuery = routePreloadedQuery(
  (order: NewsSort) =>
    loadQuery<newsPageQuery>(
      useRelayEnvironment()(),
      newsPageQuery,
      { order },
      getTimelinePageQueryLoadOptions(TIMELINE_PAGE_QUERY_CACHE_KEYS.news),
    ),
  TIMELINE_PAGE_QUERY_CACHE_KEYS.news,
);

export default function NewsPage() {
  const { t } = useLingui();
  const { activeSort, initialSort, buildHref } = useNewsSort("/news");
  const data = createStablePreloadedQuery<newsPageQuery>(newsPageQuery, () =>
    loadNewsPageQuery(initialSort),
  );

  return (
    <NarrowContainer>
      <Title>{t`Hackers' Pub: News`}</Title>
      <div class="px-4 pt-6 pb-2">
        <h1 class="text-2xl font-semibold tracking-tight">{t`News`}</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          {t`Links and articles circulating across the fediverse, ranked by how much they are being shared and discussed.`}
        </p>
      </div>
      <Show keyed when={data()}>
        {(data) => (
          <NewsList
            $stories={data}
            activeSort={activeSort}
            buildHref={buildHref}
          />
        )}
      </Show>
    </NarrowContainer>
  );
}
