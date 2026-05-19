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
import type { feedTimelineQuery } from "./__generated__/feedTimelineQuery.graphql.ts";

export const route = {
  preload({ location }) {
    // Run the SSR auth gate so anonymous visitors get a 302 to /sign instead
    // of a hydrated `<Navigate>` flash. We deliberately do NOT pre-fire the
    // timeline query here: referencing `loadFeedTimelineQuery` from this
    // route export forces Vite to bundle the generated GraphQL operation
    // module into entry-client (because `?pick=route` is statically
    // imported), which would balloon the boot bundle with one chunk per
    // route. The component fires the query itself once
    // `<AuthenticatedFeedTimeline>` mounts.
    void gateOnAuthentication(
      useRelayEnvironment()(),
      location.pathname + location.search + location.hash,
    );
  },
} satisfies RouteDefinition;

const feedTimelineQuery = graphql`
  query feedTimelineQuery($locale: Locale, $languages: [Locale!]) {
    suggestedFilterLanguages
    ...PersonalTimeline_posts @arguments(locale: $locale, languages: $languages)
  }
`;

const loadFeedTimelineQuery = routePreloadedQuery(
  (locale: string, languages: readonly string[]) =>
    loadQuery<feedTimelineQuery>(
      useRelayEnvironment()(),
      feedTimelineQuery,
      { locale, languages },
    ),
  "loadFeedTimelineQuery",
);

function normalizeLanguageParam(
  raw: string | string[] | undefined,
): string | undefined {
  const tag = Array.isArray(raw) ? raw[0] : raw;
  if (!tag) return undefined;
  try {
    return new Intl.Locale(tag).language;
  } catch {
    return undefined;
  }
}

// Mounted only after the viewer is known to be authenticated. Keeping
// `createPreloadedQuery` inside this child means the protected feed
// query is never even read for anonymous visitors — preventing the
// render path from triggering it before <Navigate> takes over.
function AuthenticatedFeedTimeline() {
  const { i18n } = useLingui();
  const location = useLocation();
  const [searchParams] = useSearchParams<{ language?: string }>();
  const activeLanguage = () => normalizeLanguageParam(searchParams.language);

  const initialLang = normalizeLanguageParam(searchParams.language);
  const data = createPreloadedQuery<feedTimelineQuery>(
    feedTimelineQuery,
    () => loadFeedTimelineQuery(i18n.locale, initialLang ? [initialLang] : []),
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
                return "/feed" + (qs ? "?" + qs : "");
              }}
            />
          </Show>
          <PersonalTimeline $posts={d} activeLanguage={activeLanguage} />
        </NarrowContainer>
      )}
    </Show>
  );
}

export default function FeedTimeline() {
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
        <AuthenticatedFeedTimeline />
      </Show>
    </Show>
  );
}
