import { graphql } from "relay-runtime";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { PostCard } from "~/components/PostCard.tsx";
import { scheduleDeferredRender } from "~/lib/deferredRender.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { SearchResults_posts$key } from "./__generated__/SearchResults_posts.graphql.ts";

const initialVisiblePosts = 5;
const visiblePostChunkSize = 5;

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
  const [visiblePostCount, setVisiblePostCount] = createSignal(
    initialVisiblePosts,
  );
  const [renderedQuery, setRenderedQuery] = createSignal(props.query());
  const edges = createMemo(() => posts()?.searchPost.edges ?? []);
  const visibleEdges = createMemo(() => edges().slice(0, visiblePostCount()));

  function onLoadMore() {
    setLoadingState("loading");
    posts.loadNext(25, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  createEffect(() => {
    const edgeCount = edges().length;
    const query = props.query();
    const previousQuery = untrack(renderedQuery);
    const queryChanged = previousQuery !== query;
    setRenderedQuery(query);

    const currentCount = queryChanged
      ? initialVisiblePosts
      : untrack(visiblePostCount);
    const startingCount = Math.min(
      edgeCount,
      Math.max(currentCount, initialVisiblePosts),
    );
    setVisiblePostCount(startingCount);

    let cancelDeferredRender = () => {};
    const revealNextChunk = () => {
      let shouldContinue = false;
      setVisiblePostCount((current) => {
        const next = Math.min(current + visiblePostChunkSize, edgeCount);
        shouldContinue = next < edgeCount;
        return next;
      });
      if (shouldContinue) {
        cancelDeferredRender = scheduleDeferredRender(revealNextChunk);
      }
    };

    if (startingCount < edgeCount) {
      cancelDeferredRender = scheduleDeferredRender(revealNextChunk);
    }
    onCleanup(() => cancelDeferredRender());
  });

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
            <For each={visibleEdges()}>
              {(edge) => <PostCard $post={edge.node} deferHeavySections />}
            </For>
            <Show
              when={posts.hasNext && visiblePostCount() >= edges().length}
            >
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
