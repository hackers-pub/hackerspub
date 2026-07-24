import { graphql } from "relay-runtime";
import {
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
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { scheduleDeferredRender } from "~/lib/deferredRender.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import { ActorPostList_posts$key } from "./__generated__/ActorPostList_posts.graphql.ts";
import { PostCard } from "./PostCard.tsx";

const initialVisiblePosts = 5;
const visiblePostChunkSize = 5;

export interface ActorPostListProps {
  $posts: ActorPostList_posts$key;
  pinConnections?: string[];
}

export function ActorPostList(props: ActorPostListProps) {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const posts = createPaginationFragment(
    graphql`
      fragment ActorPostList_posts on Actor
      @refetchable(queryName: "ActorPostListQuery")
      @argumentDefinitions(
        cursor: { type: "String" }
        count: { type: "Int", defaultValue: 20 }
        actingAccountId: { type: "ID" }
        locale: { type: "Locale" }
      ) {
        __id
        posts(after: $cursor, first: $count, actingAccountId: $actingAccountId)
          @connection(key: "ActorPostList_posts") {
          __id
          edges {
            __id
            node {
              ...PostCard_post
                @arguments(locale: $locale, actingAccountId: $actingAccountId)
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
  const [visiblePostCount, setVisiblePostCount] =
    createSignal(initialVisiblePosts);
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const edges = createMemo(() => posts()?.posts?.edges ?? []);
  const visibleEdges = createMemo(() => edges().slice(0, visiblePostCount()));

  createEffect(
    on(
      actingAccountId,
      (actingAccountId) =>
        posts.refetch({ actingAccountId: actingAccountId ?? null }),
      { defer: true },
    ),
  );

  createEffect(() => {
    const edgeCount = edges().length;
    const currentCount = untrack(visiblePostCount);
    const startingCount =
      currentCount < 1
        ? Math.min(edgeCount, initialVisiblePosts)
        : Math.min(edgeCount, Math.max(currentCount, initialVisiblePosts));
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

  function onLoadMore() {
    setLoadingState("loading");
    posts.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="my-4 overflow-hidden rounded-lg border bg-card shadow-sm">
      <Show keyed when={posts()}>
        {(data) => (
          <>
            <For each={visibleEdges()}>
              {(edge) => (
                <PostCard
                  $post={edge.node}
                  connections={data.posts?.__id ? [data.posts.__id] : []}
                  pinConnections={props.pinConnections}
                  deferHeavySections
                />
              )}
            </For>
            <Show when={posts.hasNext && visiblePostCount() >= edges().length}>
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
            <Show when={data.posts != null && edges().length < 1}>
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
