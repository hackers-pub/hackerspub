import { graphql } from "relay-runtime";
import {
  type Accessor,
  createEffect,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { PostCard } from "~/components/PostCard.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { SearchResults_posts$key } from "./__generated__/SearchResults_posts.graphql.ts";

export interface SearchResultsProps {
  query: Accessor<string>;
  $posts: SearchResults_posts$key;
}

export function SearchResults(props: SearchResultsProps) {
  const { t } = useLingui();
  const posts = createPaginationFragment(
    graphql`
      fragment SearchResults_posts on Query 
        @refetchable(queryName: "SearchResultsQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 25 }
          query: { type: "String!" }
          locale: { type: "Locale" }
          languages: { type: "[Locale!]" }
        )
      {
        __id
        searchPost(
          query: $query,
          languages: $languages,
          after: $cursor,
          first: $count,
        )
          @connection(key: "SearchResults__searchPost")
        {
          edges {
            __id
            node {
              ...PostCard_post @arguments(locale: $locale)
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$posts,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    posts.loadNext(25, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }
  createEffect(on(props.query, (query) => {
    posts.refetch({
      query,
    });
  }, {
    defer: true,
  }));

  return (
    <div class="mb-10 mt-4 overflow-hidden rounded-lg border bg-card shadow-sm md:mb-12">
      <Show keyed when={posts()}>
        {(data) => (
          <>
            <For each={data.searchPost.edges}>
              {(edge) => <PostCard $post={edge.node} />}
            </For>
            <Show when={posts.hasNext}>
              <button
                type="button"
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                disabled={posts.pending || loadingState() === "loading"}
                class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Switch>
                  <Match when={posts.pending || loadingState() === "loading"}>
                    {t`Loading more posts…`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more posts; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load more posts`}
                  </Match>
                </Switch>
              </button>
            </Show>
            <Show when={data.searchPost.edges.length < 1}>
              <div class="px-4 py-8 text-center text-muted-foreground">
                {t`No posts found`}
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
