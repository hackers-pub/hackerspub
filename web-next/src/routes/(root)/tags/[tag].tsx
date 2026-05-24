import { useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show, Suspense } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { SearchForm } from "~/components/SearchForm.tsx";
import { SearchResults } from "~/components/SearchResults.tsx";
import { SearchResultsSkeleton } from "~/components/SearchResultsSkeleton.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { TagPageQuery } from "./__generated__/TagPageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

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

const loadTagQuery = routePreloadedQuery(
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
  const { i18n } = useLingui();
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
    <NarrowContainer class="px-4 py-4 sm:py-6">
      <div class="relative mb-6">
        <SearchForm value={searchQuery()} />
      </div>
      <h1 class="text-2xl font-bold mb-4 text-primary">
        #{tag()}
      </h1>
      <Suspense fallback={<SearchResultsSkeleton />}>
        <Show keyed when={data()}>
          {(queryData) => (
            <SearchResults
              $posts={queryData}
              query={searchQuery}
            />
          )}
        </Show>
      </Suspense>
    </NarrowContainer>
  );
}
