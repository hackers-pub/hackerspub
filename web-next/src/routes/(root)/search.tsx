import {
  FULL_HANDLE_REGEXP,
  HANDLE_REGEXP,
} from "@hackerspub/models/searchPatterns";
import {
  query,
  type RouteDefinition,
  useNavigate,
  useSearchParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Accessor, createSignal, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { SearchGuide } from "~/components/SearchGuide.tsx";
import { SearchResults } from "~/components/SearchResults.tsx";
import { Trans } from "~/components/Trans.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { searchObjectPageQuery } from "./__generated__/searchObjectPageQuery.graphql.ts";
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
  const [searchQuery, setSearchQuery] = createSignal(
    (Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q) ?? "",
  );
  const [searchType, setSearchType] = createSignal(
    getSearchType(searchQuery()),
  );

  return (
    <div class="p-4">
      <div class="mb-6 relative">
        <form
          method="get"
          class="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
            const query = formData.get("q")?.toString() ?? "";
            navigate(`?q=${encodeURIComponent(query)}`);
            setSearchQuery(query);
            setSearchType(getSearchType(query));
          }}
        >
          <input
            type="text"
            name="q"
            value={searchQuery()}
            placeholder={t`Search posts…`}
            class="peer flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          <button
            type="submit"
            class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {t`Search`}
          </button>
          <div class="hidden peer-focus:block absolute top-full left-0 right-0 mt-2 z-10">
            <SearchGuide />
          </div>
        </form>
      </div>

      <Show when={searchQuery()}>
        <SearchPageContent
          searchQuery={searchQuery}
          searchType={searchType}
          setSearchType={setSearchType}
        />
      </Show>
    </div>
  );
}

function SearchPageContent(
  props: {
    searchQuery: Accessor<string>;
    searchType: Accessor<"posts" | "url" | "handle">;
    setSearchType: (type: "posts" | "url" | "handle") => void;
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
      <Show when={props.searchType() !== "posts"}>
        <SearchObjectContent
          searchQuery={props.searchQuery}
          setSearchType={props.setSearchType}
        />
      </Show>
    </>
  );
}

function SearchPostsContent(props: { searchQuery: Accessor<string> }) {
  const { i18n } = useLingui();
  // prevent fetching query here. SearchResults should handle it
  const query = props.searchQuery();

  const data = createPreloadedQuery<searchPostsPageQuery>(
    searchPostsPageQuery,
    () =>
      loadSearchPostsQuery(
        query,
        i18n.locale,
        i18n.locales != null && Array.isArray(i18n.locales) ? i18n.locales : [],
      ),
  );

  return (
    <Show when={data()}>
      {(queryData) => (
        <SearchResults $posts={queryData} query={props.searchQuery} />
      )}
    </Show>
  );
}

function SearchObjectContent(
  props: {
    searchQuery: Accessor<string>;
    setSearchType: (type: "posts" | "url" | "handle") => void;
  },
) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const data = createPreloadedQuery<searchObjectPageQuery>(
    searchObjectPageQuery,
    () => loadSearchObjectQuery(props.searchQuery()),
  );

  return (
    <Show when={data()}>
      {(data) => {
        const searchResult = data()?.searchObject;
        if (searchResult == null) {
          props.setSearchType("posts");
          return null;
        }
        if (searchResult?.__typename === "EmptySearchQueryError") {
          return (
            <div class="text-red-500">
              {t`Query cannot be empty`}
            </div>
          );
        }
        const redirectUrl = searchResult?.url;
        if (redirectUrl) {
          navigate(redirectUrl);
          return null;
        }
        return <div class="text-gray-500">{t`Not found.`}</div>;
      }}
    </Show>
  );
}
