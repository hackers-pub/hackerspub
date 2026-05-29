import { useParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show, Suspense } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { HashtagActionBar } from "~/components/HashtagActionBar.tsx";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { SearchForm } from "~/components/SearchForm.tsx";
import { SearchResults } from "~/components/SearchResults.tsx";
import { SearchResultsSkeleton } from "~/components/SearchResultsSkeleton.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { TagPageQuery } from "./__generated__/TagPageQuery.graphql.ts";

const TagPageQuery = graphql`
  query TagPageQuery(
    $query: String!
    $locale: Locale
    $languages: [Locale!]
    $tag: String!
  ) {
    viewer {
      id
      followsHashtag(tag: $tag)
      pinnedHashtags
    }
    ...SearchResults_posts
      @arguments(query: $query, locale: $locale, languages: $languages)
  }
`;

const loadTagQuery = routePreloadedQuery(
  (
    searchQuery: string,
    tag: string,
    locale: string,
    languages: readonly string[],
  ) =>
    loadQuery<TagPageQuery>(
      useRelayEnvironment()(),
      TagPageQuery,
      {
        query: searchQuery,
        tag,
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

  const data = createStablePreloadedQuery<TagPageQuery>(
    TagPageQuery,
    () =>
      loadTagQuery(
        searchQuery(),
        tag(),
        i18n.locale,
        i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
      ),
  );

  return (
    <NarrowContainer class="px-4 py-4 sm:py-6">
      <div class="relative mb-6">
        <SearchForm value={searchQuery()} />
      </div>
      <div class="mb-4 flex items-center gap-4">
        <h1 class="text-2xl font-bold text-primary">
          #{tag()}
        </h1>
        <Show keyed when={data()?.viewer}>
          {(viewer) => (
            <HashtagActionBar
              tag={tag()}
              followsHashtag={viewer.followsHashtag}
              pinnedHashtags={viewer.pinnedHashtags}
            />
          )}
        </Show>
      </div>
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
