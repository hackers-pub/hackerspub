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
import type { fediverseTimelineQuery } from "./__generated__/fediverseTimelineQuery.graphql.ts";

export const route = {
  preload() {
    const { i18n } = useLingui();
    void loadFediverseTimelineQuery(
      i18n.locale,
      i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
    );
  },
} satisfies RouteDefinition;

const fediverseTimelineQuery = graphql`
  query fediverseTimelineQuery($locale: Locale, $languages: [Locale!]) {
    viewer {
      id
    }
    ...PublicTimeline_posts @arguments(
      locale: $locale,
      languages: $languages,
      local: false,
      withoutShares: false,
      postType: null,
    )
  }
`;

const loadFediverseTimelineQuery = query(
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
  const data = createPreloadedQuery<fediverseTimelineQuery>(
    fediverseTimelineQuery,
    () =>
      loadFediverseTimelineQuery(
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
