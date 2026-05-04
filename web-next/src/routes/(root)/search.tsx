import {
  FULL_HANDLE_REGEXP,
  HANDLE_REGEXP,
} from "@hackerspub/models/searchPatterns";
import {
  Navigate,
  query,
  type RouteDefinition,
  useNavigate,
  useSearchParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { type Accessor, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { SearchGuide } from "~/components/SearchGuide.tsx";
import { SearchResults } from "~/components/SearchResults.tsx";
import { Trans } from "~/components/Trans.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { searchObjectPageQuery } from "./__generated__/searchObjectPageQuery.graphql.ts";
import type { searchObjectPageQuery$data } from "./__generated__/searchObjectPageQuery.graphql.ts";
import type { searchPostsPageQuery } from "./__generated__/searchPostsPageQuery.graphql.ts";

export const route = {
  preload({ location }) {
    const params = new URLSearchParams(location.search);
    const query = params.get("q");
    if (!query) return;

    const { i18n } = useLingui();
    const searchType = getSearchType(query);

    if (searchType === "posts") {
      void loadSearchPostsQuery(
        query,
        i18n.locale,
        i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
      );
    } else if (searchType === "handle" || searchType === "url") {
      void loadSearchObjectQuery(query);
    }
  },
} satisfies RouteDefinition;

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

const loadSearchPostsQuery = query(
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

const loadSearchObjectQuery = query(
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
  const { t } = useLingui();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const searchQuery = () =>
    (Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q) ?? "";
  const searchType = () => getSearchType(searchQuery());

  return (
    <NarrowContainer class="px-4 py-4 sm:py-6">
      <div class="relative mb-6">
        <form
          method="get"
          class="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            const query = formData.get("q")?.toString() ?? "";
            navigate(`?q=${encodeURIComponent(query)}`);
          }}
        >
          <input
            type="text"
            name="q"
            value={searchQuery()}
            placeholder={t`Search posts…`}
            class="peer min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            class="shrink-0 rounded-md bg-primary px-4 py-2 text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {t`Search`}
          </button>
          <div class="absolute left-0 right-0 top-full z-10 mt-2 hidden peer-focus:block">
            <SearchGuide />
          </div>
        </form>
      </div>

      <Show when={searchQuery()}>
        <SearchPageContent
          searchQuery={searchQuery}
          searchType={searchType}
        />
      </Show>
    </NarrowContainer>
  );
}

function SearchPageContent(
  props: {
    searchQuery: Accessor<string>;
    searchType: Accessor<"posts" | "url" | "handle">;
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
        <SearchPostsContent searchQuery={props.searchQuery} />
      </Show>
      <Show when={props.searchType() !== "posts" && props.searchQuery()} keyed>
        {(searchQuery) => <SearchObjectContent searchQuery={searchQuery} />}
      </Show>
    </>
  );
}

function SearchPostsContent(props: { searchQuery: Accessor<string> }) {
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
  },
) {
  const { t } = useLingui();

  if (props.searchResult == null) {
    return <SearchPostsContent searchQuery={() => props.searchQuery} />;
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
