import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { SearchResults } from "~/components/SearchResults.tsx";
import { Trans } from "~/components/Trans.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { TagPageQuery } from "./__generated__/TagPageQuery.graphql.ts";

export const route = {
  preload({ params }) {
    const tag = params.tag;
    if (!tag) return;

    const { i18n } = useLingui();
    void loadTagQuery(
      `#${tag}`,
      i18n.locale,
      i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
    );
  },
} satisfies RouteDefinition;

const TagPageQuery = graphql`
  query TagPageQuery($query: String!, $locale: Locale, $languages: [Locale!]) {
    viewer {
      id
    }
    ...SearchResults_posts @arguments(
      query: $query,
      locale: $locale,
      languages: $languages,
    )
  }
`;

const loadTagQuery = query(
  (
    searchQuery: string,
    locale: string,
    languages: readonly string[],
  ) =>
    loadQuery<TagPageQuery>(
      useRelayEnvironment()(),
      TagPageQuery,
      {
        query: searchQuery,
        locale,
        languages,
      },
    ),
  "loadTagQuery",
);

export default function TagPage() {
  const { i18n, t } = useLingui();
  const params = useParams<{ tag: string }>();
  const tag = () => decodeURIComponent(params.tag);
  const searchQuery = () => `#${tag()}`;

  const data = createPreloadedQuery<TagPageQuery>(
    TagPageQuery,
    () =>
      loadTagQuery(
        searchQuery(),
        i18n.locale,
        i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
      ),
  );

  return (
    <Show when={data()}>
      {(queryData) => (
        <div class="p-4">
            <h1 class="text-2xl font-bold mb-4">
              <Trans
                message={t`Posts tagged with ${"TAG"}`}
                values={{
                  TAG: () => <span class="text-primary">#{tag()}</span>,
                }}
              />
            </h1>
            <SearchResults $posts={queryData} query={searchQuery} />
          </div>
      )}
    </Show>
  );
}
