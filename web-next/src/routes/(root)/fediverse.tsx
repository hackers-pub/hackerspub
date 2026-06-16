import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { AboutHackersPub } from "~/components/AboutHackersPub.tsx";
import { FollowRecommendations } from "~/components/FollowRecommendations.tsx";
import { LanguageFilter } from "~/components/LanguageFilter.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { PublicTimeline } from "~/components/PublicTimeline.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import {
  getTimelinePageQueryLoadOptions,
  TIMELINE_PAGE_QUERY_CACHE_KEYS,
} from "~/lib/timelinePageQueryCache.ts";
import { useLanguageFilter } from "~/lib/useLanguageFilter.ts";
import type { fediverseTimelineQuery } from "./__generated__/fediverseTimelineQuery.graphql.ts";

const fediverseTimelineQuery = graphql`
  query fediverseTimelineQuery($locale: Locale, $languages: [Locale!]) {
    viewer {
      actor {
        followees(first: 0) {
          totalCount
        }
      }
      postCount
    }
    suggestedFilterLanguages
    ...PublicTimeline_posts @arguments(
      locale: $locale,
      languages: $languages,
      local: false,
      withoutShares: false,
      postType: null,
    )
  }
`;

const loadFediverseTimelineQuery = routePreloadedQuery(
  (locale: string, languages: readonly string[]) =>
    loadQuery<fediverseTimelineQuery>(
      useRelayEnvironment()(),
      fediverseTimelineQuery,
      {
        locale,
        languages,
      },
      getTimelinePageQueryLoadOptions(
        TIMELINE_PAGE_QUERY_CACHE_KEYS.fediverse,
      ),
    ),
  TIMELINE_PAGE_QUERY_CACHE_KEYS.fediverse,
);

export default function FediverseTimeline() {
  const { i18n } = useLingui();
  const { activeLanguage, initialLang, buildHref } = useLanguageFilter(
    "/fediverse",
  );
  const data = createStablePreloadedQuery<fediverseTimelineQuery>(
    fediverseTimelineQuery,
    () =>
      loadFediverseTimelineQuery(
        i18n.locale,
        initialLang ? [initialLang] : [],
      ),
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <NarrowContainer>
          <Show when={data.viewer == null}>
            <AboutHackersPub />
          </Show>
          <Show keyed when={data.viewer}>
            {(viewer) => (
              <FollowRecommendations
                followeesCount={viewer.actor.followees.totalCount}
                postCount={viewer.postCount}
              />
            )}
          </Show>
          <Show
            when={data.suggestedFilterLanguages.length > 0 ||
              !!activeLanguage()}
          >
            <LanguageFilter
              languages={data.suggestedFilterLanguages}
              activeLanguage={activeLanguage()}
              buildHref={buildHref}
            />
          </Show>
          <PublicTimeline
            $posts={data}
            activeLanguage={activeLanguage}
            local={false}
          />
        </NarrowContainer>
      )}
    </Show>
  );
}
