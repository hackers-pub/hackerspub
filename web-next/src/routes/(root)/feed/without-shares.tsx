import { Navigate, type RouteDefinition, useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { FollowRecommendations } from "~/components/FollowRecommendations.tsx";
import { LanguageFilter } from "~/components/LanguageFilter.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { PersonalTimeline } from "~/components/PersonalTimeline.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { buildSignInHref, gateOnAuthentication } from "~/lib/authGate.ts";
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
import type { withoutSharesFeedTimelineQuery } from "./__generated__/withoutSharesFeedTimelineQuery.graphql.ts";

export const route = {
  preload({ location }) {
    // Run the SSR auth gate so anonymous visitors get a 302 to /sign instead
    // of a hydrated `<Navigate>` flash. We deliberately do NOT pre-fire the
    // timeline query here: referencing the load function from this route
    // export forces Vite to bundle the generated GraphQL operation module
    // into entry-client (because `?pick=route` is statically imported),
    // which would balloon the boot bundle with one chunk per route. The
    // component fires the query itself once it mounts under the
    // authenticated branch.
    void gateOnAuthentication(
      useRelayEnvironment()(),
      location.pathname + location.search + location.hash,
    );
  },
} satisfies RouteDefinition;

const withoutSharesFeedTimelineQuery = graphql`
  query withoutSharesFeedTimelineQuery($locale: Locale, $languages: [Locale!]) {
    viewer {
      actor {
        followees(first: 0) {
          totalCount
        }
      }
      postCount
    }
    suggestedFilterLanguages
    ...PersonalTimeline_posts @arguments(locale: $locale, languages: $languages, withoutShares: true)
  }
`;

const loadWithoutSharesFeedTimelineQuery = routePreloadedQuery(
  (locale: string, languages: readonly string[]) =>
    loadQuery<withoutSharesFeedTimelineQuery>(
      useRelayEnvironment()(),
      withoutSharesFeedTimelineQuery,
      { locale, languages },
      getTimelinePageQueryLoadOptions(
        TIMELINE_PAGE_QUERY_CACHE_KEYS.feedWithoutShares,
      ),
    ),
  TIMELINE_PAGE_QUERY_CACHE_KEYS.feedWithoutShares,
);

function AuthenticatedWithoutSharesFeedTimeline() {
  const { i18n } = useLingui();
  const { activeLanguage, initialLang, buildHref } = useLanguageFilter(
    "/feed/without-shares",
  );
  const data = createStablePreloadedQuery<withoutSharesFeedTimelineQuery>(
    withoutSharesFeedTimelineQuery,
    () =>
      loadWithoutSharesFeedTimelineQuery(
        i18n.locale,
        initialLang ? [initialLang] : [],
      ),
  );

  return (
    <Show keyed when={data()}>
      {(d) => (
        <NarrowContainer>
          <Show keyed when={d.viewer}>
            {(viewer) => (
              <FollowRecommendations
                followeesCount={viewer.actor.followees.totalCount}
                postCount={viewer.postCount}
              />
            )}
          </Show>
          <Show
            when={d.suggestedFilterLanguages.length > 0 || !!activeLanguage()}
          >
            <LanguageFilter
              languages={d.suggestedFilterLanguages}
              activeLanguage={activeLanguage()}
              buildHref={buildHref}
            />
          </Show>
          <PersonalTimeline
            $posts={d}
            activeLanguage={activeLanguage}
            withoutShares
          />
        </NarrowContainer>
      )}
    </Show>
  );
}

export default function WithoutSharesFeedTimeline() {
  const viewer = useViewer();
  const location = useLocation();
  const signInHref = () =>
    buildSignInHref(location.pathname + location.search + location.hash);

  return (
    <Show when={viewer.isLoaded()}>
      <Show
        when={viewer.isAuthenticated()}
        fallback={<Navigate href={signInHref()} />}
      >
        <AuthenticatedWithoutSharesFeedTimeline />
      </Show>
    </Show>
  );
}
