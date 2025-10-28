import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { ArticleSharerList_article$key } from "./__generated__/ArticleSharerList_article.graphql.ts";
import { SmallProfileCard } from "./SmallProfileCard.tsx";

export interface ArticleSharerListProps {
  $article: ArticleSharerList_article$key;
}

export function ArticleSharerList(props: ArticleSharerListProps) {
  const { t } = useLingui();
  const article = createPaginationFragment(
    graphql`
      fragment ArticleSharerList_article on Article
        @refetchable(queryName: "ArticleSharerListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        __id
        shares(after: $cursor, first: $count)
          @connection(key: "ArticleSharerList_shares")
        {
          edges {
            node {
              id
              actor {
                ...SmallProfileCard_actor
              }
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$article,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    article.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="my-4">
      <Show when={article()}>
        {(data) => (
          <>
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <For each={data().shares.edges}>
                {(edge) => (
                  <div class="border rounded-lg">
                    <SmallProfileCard $actor={edge.node.actor} />
                  </div>
                )}
              </For>
            </div>
            <Show when={article.hasNext}>
              <div
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                class="mt-4 px-4 py-8 text-center text-muted-foreground cursor-pointer hover:text-primary hover:bg-secondary rounded-lg border"
              >
                <Switch>
                  <Match
                    when={article.pending || loadingState() === "loading"}
                  >
                    {t`Loading more sharers…`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more sharers; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load more sharers`}
                  </Match>
                </Switch>
              </div>
            </Show>
            <Show when={data().shares.edges.length < 1}>
              <div class="px-4 py-8 text-center text-muted-foreground border rounded-lg">
                {t`No sharers found`}
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
