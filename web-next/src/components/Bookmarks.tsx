import { graphql } from "relay-runtime";
import {
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
import type { Bookmarks_posts$key } from "./__generated__/Bookmarks_posts.graphql.ts";

export type BookmarkPostType = "ARTICLE" | "NOTE" | null;

export interface BookmarksProps {
  $posts: Bookmarks_posts$key;
  postType?: BookmarkPostType;
}

export function Bookmarks(props: BookmarksProps) {
  const { t } = useLingui();
  const posts = createPaginationFragment(
    graphql`
      fragment Bookmarks_posts on Query
        @refetchable(queryName: "BookmarksQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 25 }
          locale: { type: "Locale" }
          postType: { type: "PostType", defaultValue: null }
        )
      {
        __id
        bookmarks(after: $cursor, first: $count, postType: $postType)
          @connection(key: "Bookmarks__bookmarks")
        {
          __id
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

  createEffect(
    on(
      () => props.postType ?? null,
      (postType) => {
        posts.refetch({ postType });
      },
      { defer: true },
    ),
  );

  function onLoadMore() {
    setLoadingState("loading");
    posts.loadNext(25, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="border-x">
      <Show when={posts()}>
        {(data) => (
          <>
            <For each={data().bookmarks.edges}>
              {(edge) => (
                <PostCard
                  $post={edge.node}
                  connections={[data().bookmarks.__id]}
                  bookmarkListConnections={[data().bookmarks.__id]}
                />
              )}
            </For>
            <Show when={posts.hasNext}>
              <div
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                class="block px-4 py-8 text-center text-muted-foreground cursor-pointer hover:text-primary hover:bg-secondary"
              >
                <Switch>
                  <Match when={posts.pending || loadingState() === "loading"}>
                    {t`Loading more bookmarks…`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more bookmarks; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load more bookmarks`}
                  </Match>
                </Switch>
              </div>
            </Show>
            <Show when={data().bookmarks.edges.length < 1}>
              <div class="px-4 py-8 text-center text-muted-foreground">
                {t`No bookmarks yet`}
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
