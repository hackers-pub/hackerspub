import { query, type RouteDefinition } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { AboutHackersPub } from "~/components/AboutHackersPub.tsx";
import { PublicTimeline } from "~/components/PublicTimeline.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { localTimelineQuery } from "./__generated__/localTimelineQuery.graphql.ts";

export const route = {
  preload() {
    const { i18n } = useLingui();
    void loadLocalTimelineQuery(
      i18n.locale,
      i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
    );
  },
} satisfies RouteDefinition;

const localTimelineQuery = graphql`
  query localTimelineQuery($locale: Locale, $languages: [Locale!]) {
    viewer {
      id
    }
    ...PublicTimeline_posts @arguments(
      locale: $locale,
      languages: $languages,
      local: true,
      withoutShares: false,
      postType: null,
    )
  }
`;

const loadLocalTimelineQuery = query(
  (locale: string, languages: readonly string[]) =>
    loadQuery<localTimelineQuery>(useRelayEnvironment()(), localTimelineQuery, {
      locale,
      languages,
    }),
  "loadLocalTimelineQuery",
);

export default function LocalTimeline() {
  const { i18n, t } = useLingui();
  const data = createPreloadedQuery<localTimelineQuery>(
    localTimelineQuery,
    () =>
      loadLocalTimelineQuery(
        i18n.locale,
        i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
      ),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <>
          <Show when={data().viewer == null}>
            <AboutHackersPub />
          </Show>
          <div class="p-4">
            <PublicTimeline $posts={data()} />
          </div>
        </>
      )}
    </Show>
  );
}
