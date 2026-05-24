import { parseQuery } from "@hackerspub/models/search";
import {
  FULL_HANDLE_REGEXP,
  HANDLE_REGEXP,
} from "@hackerspub/models/searchPatterns";
import { Navigate, useNavigate, useSearchParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { type Accessor, createEffect, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { SearchForm } from "~/components/SearchForm.tsx";
import { SearchGuide } from "~/components/SearchGuide.tsx";
import { SearchResults } from "~/components/SearchResults.tsx";
import { SearchResultsSkeleton } from "~/components/SearchResultsSkeleton.tsx";
import { Trans } from "~/components/Trans.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { searchObjectPageQuery } from "./__generated__/searchObjectPageQuery.graphql.ts";
import type { searchObjectPageQuery$data } from "./__generated__/searchObjectPageQuery.graphql.ts";
import type { searchPostsPageQuery } from "./__generated__/searchPostsPageQuery.graphql.ts";
import type { searchPostsPageQuery$data } from "./__generated__/searchPostsPageQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

const searchPostsPageQuery = graphql`
  query searchPostsPageQuery($query: String!, $locale: Locale, $languages: [Locale!]) {
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

const searchObjectPageQuery = graphql`
  query searchObjectPageQuery($query: String!) {
    searchObject(query: $query) {
      ... on SearchedObject {
        url
      }
      ... on EmptySearchQueryError {
        __typename
      }
    }
  }
`;

function getSearchType(searchQuery: string): "handle" | "url" | "posts" {
  if (URL.canParse(searchQuery)) {
    return "url";
  }
  if (HANDLE_REGEXP.test(searchQuery) || FULL_HANDLE_REGEXP.test(searchQuery)) {
    return "handle";
  }
  return "posts";
}

const loadSearchPostsQuery = routePreloadedQuery(
  (
    searchQuery: string,
    locale: string,
    languages: readonly string[],
  ) => ({
    ...loadQuery<searchPostsPageQuery>(
      useRelayEnvironment()(),
      searchPostsPageQuery,
      {
        query: searchQuery,
        locale,
        languages,
      },
    ),
    fetchKey: searchQuery,
  }),
  "loadSearchPostsQuery",
);

const loadSearchObjectQuery = routePreloadedQuery(
  (searchQuery: string) =>
    loadQuery<searchObjectPageQuery>(
      useRelayEnvironment()(),
      searchObjectPageQuery,
      {
        query: searchQuery,
      },
    ),
  "loadSearchObjectQuery",
);

export default function SearchPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { i18n, t } = useLingui();
  const searchQuery = () =>
    (Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q) ?? "";

  createEffect(() => {
    const expr = parseQuery(searchQuery());
    if (expr?.type === "hashtag") {
      navigate(`/tags/${encodeURIComponent(expr.hashtag)}`, { replace: true });
    }
  });

  // Both queries lifted to top level so <Suspense> is not needed.
  // Without <Suspense>, createPreloadedQuery returns undefined (not throws)
  // while loading, so SSR and client hydration agree on the initial
  // skeleton state — avoiding the streaming-replacement hydration mismatch
  // that occurs when Relay store data is not serialized from server to client.
  const postsData = createPreloadedQuery<searchPostsPageQuery>(
    searchPostsPageQuery,
    () =>
      loadSearchPostsQuery(
        searchQuery(),
        i18n.locale,
        i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
      ),
  );

  const objectData = createPreloadedQuery<searchObjectPageQuery>(
    searchObjectPageQuery,
    () => loadSearchObjectQuery(searchQuery()),
  );

  return (
    <NarrowContainer class="px-4 py-4 sm:py-6">
      <div class="relative mb-6">
        <SearchForm value={searchQuery()} />
      </div>

      <Show when={searchQuery()} fallback={<SearchGuide />}>
        <h1 class="text-2xl font-bold mb-4">
          <Trans
            message={t`Search results for ${"KEYWORD"}`}
            values={{ KEYWORD: () => <q>{searchQuery()}</q> }}
          />
        </h1>
        <Show when={getSearchType(searchQuery()) === "posts"}>
          <Show
            when={postsData()}
            fallback={<SearchResultsSkeleton />}
            keyed
          >
            {(queryData) => (
              <SearchResults $posts={queryData} query={searchQuery} />
            )}
          </Show>
        </Show>
        <Show when={getSearchType(searchQuery()) !== "posts"}>
          <Show when={objectData()} keyed>
            {(data) => (
              <SearchObjectResult
                searchResult={data.searchObject}
                searchQuery={searchQuery}
                postsData={postsData}
              />
            )}
          </Show>
        </Show>
      </Show>
    </NarrowContainer>
  );
}

type SearchObjectResultData = searchObjectPageQuery$data["searchObject"];

function SearchObjectResult(
  props: {
    searchResult: SearchObjectResultData;
    searchQuery: Accessor<string>;
    postsData: Accessor<searchPostsPageQuery$data | undefined>;
  },
) {
  const { t } = useLingui();

  if (props.searchResult == null) {
    return (
      <Show
        when={props.postsData()}
        fallback={<SearchResultsSkeleton />}
        keyed
      >
        {(queryData) => (
          <SearchResults $posts={queryData} query={props.searchQuery} />
        )}
      </Show>
    );
  }
  if ("url" in props.searchResult && props.searchResult.url) {
    return <Navigate href={props.searchResult.url} />;
  }
  if (props.searchResult.__typename === "EmptySearchQueryError") {
    return (
      <div class="text-red-500">
        {t`Query cannot be empty`}
      </div>
    );
  }
  return <div>{t`No matching object found`}</div>;
}
