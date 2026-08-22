import { graphql } from "relay-runtime";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { PostCard } from "~/components/PostCard.tsx";
import { VirtualizedPostList } from "~/components/VirtualizedPostList.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { SearchResults_posts$key } from "./__generated__/SearchResults_posts.graphql.ts";

const initialVisiblePosts = 5;

export interface SearchResultsProps {
  query: Accessor<string>;
  $posts: SearchResults_posts$key;
}

export function SearchResults(props: SearchResultsProps) {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const posts = createPaginationFragment(
    graphql`
      fragment SearchResults_posts on Query
      @refetchable(queryName: "SearchResultsQuery")
      @argumentDefinitions(
        cursor: { type: "String" }
        count: { type: "Int", defaultValue: 25 }
        actingAccountId: { type: "ID" }
        query: { type: "String!" }
        locale: { type: "Locale" }
        languages: { type: "[Locale!]" }
      ) {
        __id
        searchPost(
          query: $query
          languages: $languages
          after: $cursor
          first: $count
        ) @connection(key: "SearchResults__searchPost") {
          edges {
            __id
            node {
              id
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
  const actingAccountId = () => actingAccount.selectedActingAccountId();
  const edges = createMemo(() => posts()?.searchPost.edges ?? []);

  function onLoadMore() {
    setLoadingState("loading");
    posts.loadNext(25, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  createEffect(
    on(
      () => `${props.query()}:${actingAccountId() ?? ""}`,
      () => {
        const query = props.query();
        posts.refetch({
          actingAccountId: actingAccountId() ?? null,
          query,
        });
      },
      {
        defer: true,
      },
    ),
  );

  return (
    <div class="mb-10 mt-4 overflow-hidden rounded-lg border bg-card shadow-sm md:mb-12">
      <Show keyed when={posts()}>
        {(data) => (
          <>
            <VirtualizedPostList
              items={edges()}
              getItemKey={(edge) => edge.node.id}
              initialItemCount={initialVisiblePosts}
              renderItem={(edge) => <PostCard $post={edge.node} />}
              hasFooter={posts.hasNext}
              renderFooter={() => (
                <button
                  type="button"
                  on:click={
                    loadingState() === "loading" ? undefined : onLoadMore
                  }
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
              )}
            />
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
