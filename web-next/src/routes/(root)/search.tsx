import {
  FULL_HANDLE_REGEXP,
  HANDLE_REGEXP,
} from "@hackerspub/models/searchPatterns";
import { Navigate, useNavigate, useSearchParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import {
  type Accessor,
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { NarrowContainer } from "~/components/NarrowContainer.tsx";
import { SearchGuide } from "~/components/SearchGuide.tsx";
import { SearchResults } from "~/components/SearchResults.tsx";
import { Trans } from "~/components/Trans.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Skeleton } from "~/components/ui/skeleton.tsx";
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
  const { t } = useLingui();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [isPending, setIsPending] = createSignal(false);
  const searchQuery = () =>
    (Array.isArray(searchParams.q) ? searchParams.q[0] : searchParams.q) ?? "";
  let searchInput: HTMLInputElement | undefined;

  createEffect(() => {
    if (searchQuery() === "") setIsPending(false);
  });

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
            searchInput?.blur();
            if (query === searchQuery()) return;
            if (query !== "") setIsPending(true);
            navigate(`?q=${encodeURIComponent(query)}`);
          }}
        >
          <div class="relative min-w-0 flex-1">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              stroke-width="1.5"
              stroke="currentColor"
              aria-hidden="true"
              class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
              />
            </svg>
            <input
              ref={searchInput}
              type="search"
              name="q"
              value={searchQuery()}
              placeholder={t`Search posts…`}
              aria-label={t`Search`}
              class="peer flex h-10 w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
            <Show when={searchQuery()}>
              <div class="absolute left-0 right-0 top-full z-10 mt-2 hidden peer-focus:block">
                <SearchGuide />
              </div>
            </Show>
          </div>
          <Button
            type="submit"
            disabled={isPending()}
            aria-busy={isPending()}
            class="shrink-0"
          >
            <Show
              when={isPending()}
              fallback={t`Search`}
            >
              <SearchSpinnerIcon />
              <span>{t`Searching…`}</span>
            </Show>
          </Button>
        </form>
      </div>

      <Show
        when={searchQuery()}
        fallback={<SearchGuide />}
        keyed
      >
        {(query) => (
          <Suspense
            fallback={<SearchResultsSkeleton onActive={setIsPending} />}
          >
            <SearchPageContent
              searchQuery={() => query}
              searchType={() => getSearchType(query)}
              onLoaded={() => setIsPending(false)}
            />
          </Suspense>
        )}
      </Show>
    </NarrowContainer>
  );
}

function SearchSpinnerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      aria-hidden="true"
      class="animate-spin"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
      />
    </svg>
  );
}

function SearchResultsSkeleton(
  props: { onActive?: (active: boolean) => void },
) {
  const { t } = useLingui();
  onMount(() => props.onActive?.(true));
  onCleanup(() => props.onActive?.(false));
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      class="mb-10 mt-4 overflow-hidden rounded-lg border bg-card shadow-sm md:mb-12"
    >
      <span class="sr-only">{t`Loading search results…`}</span>
      <Skeleton class="h-7 w-1/2 m-4" />
      <For each={[0, 1, 2, 3]}>
        {() => (
          <div class="flex gap-4 border-t p-4">
            <Skeleton class="size-10 shrink-0 rounded-full" />
            <div class="flex-1 space-y-2 py-1">
              <Skeleton class="h-4 w-1/3" />
              <Skeleton class="h-3 w-full" />
              <Skeleton class="h-3 w-5/6" />
            </div>
          </div>
        )}
      </For>
    </div>
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
  onMount(() => props.onLoaded());
  if (props.searchResult.__typename === "EmptySearchQueryError") {
    return (
      <div class="text-red-500">
        {t`Query cannot be empty`}
      </div>
    );
  }
  return <div>{t`No matching object found`}</div>;
}
