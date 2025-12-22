import { query, type RouteDefinition } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { PersonalTimeline } from "~/components/PersonalTimeline.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { feedTimelineQuery } from "./__generated__/feedTimelineQuery.graphql.ts";

export const route = {
  preload() {
    const { i18n } = useLingui();
    void loadFeedTimelineQuery(i18n.locale);
  },
} satisfies RouteDefinition;

const feedTimelineQuery = graphql`
  query feedTimelineQuery($locale: Locale) {
    ...PersonalTimeline_posts @arguments(locale: $locale)
  }
`;

const loadFeedTimelineQuery = query(
  (locale: string) =>
    loadQuery<feedTimelineQuery>(
      useRelayEnvironment()(),
      feedTimelineQuery,
      { locale },
    ),
  "loadFeedTimelineQuery",
);

export default function FeedTimeline() {
  const { i18n } = useLingui();
  const data = createPreloadedQuery<feedTimelineQuery>(
    feedTimelineQuery,
    () => loadFeedTimelineQuery(i18n.locale),
  );

  return (
    <Show when={data()}>
      {(data) => <PersonalTimeline $posts={data()} />}
    </Show>
  );
}
