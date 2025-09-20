import { graphql } from "relay-runtime";
import {
  Accessor,
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
  $posts: Accessor<SearchResults_posts$key>;
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
    () => props.$posts(),
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
    <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl max-w-prose mx-auto my-4">
      <Show when={posts()}>
        {(data) => (
          <>
            <For each={data().searchPost.edges}>
              {(edge) => <PostCard $post={edge.node} />}
            </For>
            <Show when={posts.hasNext}>
              <div
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                class="block px-4 py-8 text-center text-muted-foreground cursor-pointer hover:text-primary hover:bg-secondary"
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
              </div>
            </Show>
            <Show when={data().searchPost.edges.length < 1}>
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
