import { Navigate, type RouteDefinition, useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { FollowRecommendations } from "~/components/FollowRecommendations.tsx";
import { LanguageFilter } from "~/components/LanguageFilter.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { PersonalTimeline } from "~/components/PersonalTimeline.tsx";
import { Title } from "~/components/Title.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
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
import type { articlesFeedTimelineQuery } from "./__generated__/articlesFeedTimelineQuery.graphql.ts";

export const route = {
  preload() {
    // Check auth status without pre-firing the protected timeline query:
    // referencing the load function from this route export forces Vite to
    // bundle the generated GraphQL operation module into entry-client
    // (because `?pick=route` is statically imported), which would balloon the
    // boot bundle with one chunk per route. The component fires the query
    // itself once it mounts under the authenticated branch.
    void gateOnAuthentication(useRelayEnvironment()());
  },
} satisfies RouteDefinition;

const articlesFeedTimelineQuery = graphql`
  query articlesFeedTimelineQuery(
    $actingAccountId: ID
    $locale: Locale
    $languages: [Locale!]
  ) {
    viewer {
      actor {
        followees(first: 0) {
          totalCount
        }
      }
      postCount
    }
    suggestedFilterLanguages
    ...PersonalTimeline_posts @arguments(
      actingAccountId: $actingAccountId,
      locale: $locale,
      languages: $languages,
      postType: ARTICLE
    )
  }
`;

const loadArticlesFeedTimelineQuery = routePreloadedQuery(
  (
    locale: string,
    languages: readonly string[],
    actingAccountId: string | null,
  ) =>
    loadQuery<articlesFeedTimelineQuery>(
      useRelayEnvironment()(),
      articlesFeedTimelineQuery,
      { locale, languages, actingAccountId },
      getTimelinePageQueryLoadOptions(
        TIMELINE_PAGE_QUERY_CACHE_KEYS.feedArticles,
      ),
    ),
  TIMELINE_PAGE_QUERY_CACHE_KEYS.feedArticles,
);

function AuthenticatedArticlesFeedTimeline() {
  const { i18n } = useLingui();
  const actingAccount = useActingAccount();
  const { activeLanguage, initialLang, buildHref } = useLanguageFilter(
    "/feed/articles",
  );
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const data = createStablePreloadedQuery<articlesFeedTimelineQuery>(
    articlesFeedTimelineQuery,
    () =>
      loadArticlesFeedTimelineQuery(
        i18n.locale,
        initialLang ? [initialLang] : [],
        actingAccountId() ?? null,
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
            when={(d.suggestedFilterLanguages?.length ?? 0) > 0 ||
              !!activeLanguage()}
          >
            <LanguageFilter
              languages={d.suggestedFilterLanguages ?? []}
              activeLanguage={activeLanguage()}
              buildHref={buildHref}
            />
          </Show>
          <PersonalTimeline
            $posts={d}
            actingAccountId={actingAccountId}
            activeLanguage={activeLanguage}
            postType="ARTICLE"
          />
        </NarrowContainer>
      )}
    </Show>
  );
}

export default function ArticlesFeedTimeline() {
  const viewer = useViewer();
  const location = useLocation();
  const { t } = useLingui();
  const signInHref = () =>
    buildSignInHref(location.pathname + location.search + location.hash);

  return (
    <>
      <Title>{t`Hackers' Pub: Articles feed`}</Title>
      <Show when={viewer.isLoaded()}>
        <Show
          when={viewer.isAuthenticated()}
          fallback={<Navigate href={signInHref()} />}
        >
          <AuthenticatedArticlesFeedTimeline />
        </Show>
      </Show>
    </>
  );
}
