import {
  Navigate,
  type RouteDefinition,
  useLocation,
  useSearchParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { LanguageFilter } from "~/components/LanguageFilter.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { PersonalTimeline } from "~/components/PersonalTimeline.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { buildSignInHref, gateOnAuthentication } from "~/lib/authGate.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";
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

function normalizeLanguageParam(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new Intl.Locale(raw).language;
  } catch {
    return undefined;
  }
}

function AuthenticatedArticlesFeedTimeline() {
  const { i18n } = useLingui();
  const location = useLocation();
  const [searchParams] = useSearchParams<{ language?: string }>();
  const activeLanguage = () => normalizeLanguageParam(searchParams.language);
  const data = createPreloadedQuery<articlesFeedTimelineQuery>(
    articlesFeedTimelineQuery,
    () => {
      const lang = activeLanguage();
      return loadArticlesFeedTimelineQuery(i18n.locale, lang ? [lang] : []);
    },
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
              buildHref={(lang) => {
                const p = new URLSearchParams(location.search);
                if (lang) p.set("language", lang);
                else p.delete("language");
                const qs = p.toString();
                return "/feed/articles" + (qs ? "?" + qs : "");
              }}
            />
          </Show>
          <PersonalTimeline $posts={d} />
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
