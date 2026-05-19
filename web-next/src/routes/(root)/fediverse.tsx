import { useLocation, useSearchParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { AboutHackersPub } from "~/components/AboutHackersPub.tsx";
import { LanguageFilter } from "~/components/LanguageFilter.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { PublicTimeline } from "~/components/PublicTimeline.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { normalizeLanguageParam } from "~/lib/languageParam.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";
import type { fediverseTimelineQuery } from "./__generated__/fediverseTimelineQuery.graphql.ts";

const fediverseTimelineQuery = graphql`
  query fediverseTimelineQuery($locale: Locale, $languages: [Locale!]) {
    viewer {
      id
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
    ),
  "loadFediverseTimelineQuery",
);

export default function FediverseTimeline() {
  const { i18n } = useLingui();
  const location = useLocation();
  const [searchParams] = useSearchParams<{ language?: string }>();
  const activeLanguage = () => normalizeLanguageParam(searchParams.language);

  const initialLang = normalizeLanguageParam(searchParams.language);
  const data = createPreloadedQuery<fediverseTimelineQuery>(
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
          <Show
            when={data.suggestedFilterLanguages.length > 0 ||
              !!activeLanguage()}
          >
            <LanguageFilter
              languages={data.suggestedFilterLanguages}
              activeLanguage={activeLanguage()}
              buildHref={(lang) => {
                const p = new URLSearchParams(location.search);
                if (lang) p.set("language", lang);
                else p.delete("language");
                const qs = p.toString();
                return "/fediverse" + (qs ? "?" + qs : "");
              }}
            />
          </Show>
          <PublicTimeline $posts={data} activeLanguage={activeLanguage} />
        </NarrowContainer>
      )}
    </Show>
  );
}
