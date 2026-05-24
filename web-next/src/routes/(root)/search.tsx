import { parseQuery } from "@hackerspub/models/search";
import {
  FULL_HANDLE_REGEXP,
  HANDLE_REGEXP,
} from "@hackerspub/models/searchPatterns";
import { Navigate, useNavigate, useSearchParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { type Accessor, createEffect, on, Show, Suspense } from "solid-js";
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
  const searchQuery = () =>
    (Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q) ?? "";

  createEffect(() => {
    const expr = parseQuery(searchQuery());
    if (expr?.type === "hashtag") {
      navigate(`/tags/${encodeURIComponent(expr.hashtag)}`, { replace: true });
    }
  });

  return (
    <NarrowContainer class="px-4 py-4 sm:py-6">
      <div class="relative mb-6">
        <SearchForm value={searchQuery()} />
      </div>

      <Show
        when={searchQuery()}
        fallback={<SearchGuide />}
        keyed
      >
        {(query) => (
          <Suspense fallback={<SearchResultsSkeleton />}>
            <SearchPageContent
              searchQuery={() => query}
              searchType={() => getSearchType(query)}
              onLoaded={() => {}}
            />
          </Suspense>
        )}
      </Show>
    </NarrowContainer>
  );
}

function SearchPageContent(
  props: {
    searchQuery: Accessor<string>;
    searchType: Accessor<"posts" | "url" | "handle">;
    onLoaded: () => void;
  },
) {
  const { t } = useLingui();

  return (
    <>
      <h1 class="text-2xl font-bold mb-4">
        <Trans
          message={t`Search results for ${"KEYWORD"}`}
          values={{ KEYWORD: () => <q>{props.searchQuery()}</q> }}
        />
      </h1>
      <Show when={props.searchType() === "posts"}>
        <SearchPostsContent
          searchQuery={props.searchQuery}
          onLoaded={props.onLoaded}
        />
      </Show>
      <Show when={props.searchType() !== "posts" && props.searchQuery()} keyed>
        {(searchQuery) => (
          <SearchObjectContent
            searchQuery={searchQuery}
            onLoaded={props.onLoaded}
          />
        )}
      </Show>
    </>
  );
}

function SearchPostsContent(
  props: { searchQuery: Accessor<string>; onLoaded: () => void },
) {
  const { i18n } = useLingui();
  const initialSearchQuery = props.searchQuery();

  const data = createPreloadedQuery<searchPostsPageQuery>(
    searchPostsPageQuery,
    () =>
      loadSearchPostsQuery(
        initialSearchQuery,
        i18n.locale,
        i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
      ),
  );
  createEffect(on(data, (value) => {
    if (value != null) props.onLoaded();
  }));

  return (
    <Show keyed when={data()}>
      {(queryData) => (
        <SearchResults $posts={queryData} query={props.searchQuery} />
      )}
    </Show>
  );
}

function SearchObjectContent(
  props: {
    searchQuery: string;
    onLoaded: () => void;
  },
) {
  const data = createPreloadedQuery<searchObjectPageQuery>(
    searchObjectPageQuery,
    () => loadSearchObjectQuery(props.searchQuery),
  );

  return (
    <Show when={data()} keyed>
      {(data) => (
        <SearchObjectResult
          searchResult={data.searchObject}
          searchQuery={props.searchQuery}
          onLoaded={props.onLoaded}
        />
      )}
    </Show>
  );
}

type SearchObjectResultData = searchObjectPageQuery$data["searchObject"];

function SearchObjectResult(
  props: {
    searchResult: SearchObjectResultData;
    searchQuery: string;
    onLoaded: () => void;
  },
) {
  const { t } = useLingui();

  if (props.searchResult == null) {
    return (
      <SearchPostsContent
        searchQuery={() => props.searchQuery}
        onLoaded={props.onLoaded}
      />
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
