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
import type { localTimelineQuery } from "./__generated__/localTimelineQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

const localTimelineQuery = graphql`
  query localTimelineQuery($locale: Locale, $languages: [Locale!]) {
    viewer {
      id
    }
    suggestedFilterLanguages
    ...PublicTimeline_posts @arguments(
      locale: $locale,
      languages: $languages,
      local: true,
      withoutShares: false,
      postType: null,
    )
  }
`;

const loadLocalTimelineQuery = routePreloadedQuery(
  (locale: string, languages: readonly string[]) =>
    loadQuery<localTimelineQuery>(useRelayEnvironment()(), localTimelineQuery, {
      locale,
      languages,
    }),
  "loadLocalTimelineQuery",
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

export default function LocalTimeline() {
  const { i18n } = useLingui();
  const location = useLocation();
  const [searchParams] = useSearchParams<{ language?: string }>();
  const activeLanguage = () => normalizeLanguageParam(searchParams.language);
  const data = createPreloadedQuery<localTimelineQuery>(
    localTimelineQuery,
    () => {
      const lang = activeLanguage();
      return loadLocalTimelineQuery(i18n.locale, lang ? [lang] : []);
    },
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
                return "/local" + (qs ? "?" + qs : "");
              }}
            />
          </Show>
          <PublicTimeline $posts={data} />
        </NarrowContainer>
      )}
    </Show>
  );
}
