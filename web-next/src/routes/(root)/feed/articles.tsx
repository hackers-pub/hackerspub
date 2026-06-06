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
import { useLanguageFilter } from "~/lib/useLanguageFilter.ts";
import type { articlesFeedTimelineQuery } from "./__generated__/articlesFeedTimelineQuery.graphql.ts";

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

const articlesFeedTimelineQuery = graphql`
  query articlesFeedTimelineQuery($locale: Locale, $languages: [Locale!]) {
    suggestedFilterLanguages
    ...PersonalTimeline_posts @arguments(locale: $locale, languages: $languages, postType: ARTICLE)
  }
`;

const loadArticlesFeedTimelineQuery = routePreloadedQuery(
  (locale: string, languages: readonly string[]) =>
    loadQuery<articlesFeedTimelineQuery>(
      useRelayEnvironment()(),
      articlesFeedTimelineQuery,
      { locale, languages },
    ),
  "loadArticlesFeedTimelineQuery",
);

function AuthenticatedArticlesFeedTimeline() {
  const { i18n } = useLingui();
  const { activeLanguage, initialLang, buildHref } = useLanguageFilter(
    "/feed/articles",
  );
  const data = createStablePreloadedQuery<articlesFeedTimelineQuery>(
    articlesFeedTimelineQuery,
    () =>
      loadArticlesFeedTimelineQuery(
        i18n.locale,
        initialLang ? [initialLang] : [],
      ),
  );

  return (
    <Show keyed when={data()}>
      {(d) => (
        <NarrowContainer>
          <Show
            when={d.suggestedFilterLanguages.length > 0 || !!activeLanguage()}
          >
            <LanguageFilter
              languages={d.suggestedFilterLanguages}
              activeLanguage={activeLanguage()}
              buildHref={buildHref}
            />
          </Show>
          <FollowRecommendations />
          <PersonalTimeline
            $posts={d}
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
  const signInHref = () =>
    buildSignInHref(location.pathname + location.search + location.hash);

  return (
    <Show when={viewer.isLoaded()}>
      <Show
        when={viewer.isAuthenticated()}
        fallback={<Navigate href={signInHref()} />}
      >
        <AuthenticatedArticlesFeedTimeline />
      </Show>
    </Show>
  );
}
