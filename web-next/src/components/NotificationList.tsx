import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { NotificationList_notifications$key } from "./__generated__/NotificationList_notifications.graphql.ts";
import { NotificationCard } from "./NotificationCard.tsx";

export interface NotificationListProps {
  $account: NotificationList_notifications$key;
}

export function NotificationList(props: NotificationListProps) {
  const { t } = useLingui();
  const notifications = createPaginationFragment(
    graphql`
      fragment NotificationList_notifications on Account
        @refetchable(queryName: "NotificationListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        notifications(after: $cursor, first: $count)
          @connection(key: "NotificationList_notifications")
        {
          edges {
            node {
              ...NotificationCard_notification
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$account,
  );

  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    notifications.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <Show keyed when={notifications()}>
      {(data) => (
        <>
          <ul class="mb-10 flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm md:mb-12">
            <For each={data.notifications.edges}>
              {(edge) => <NotificationCard $notification={edge.node} />}
            </For>
            <Show when={notifications.hasNext}>
              <li>
                <button
                  type="button"
                  on:click={loadingState() === "loading"
                    ? undefined
                    : onLoadMore}
                  disabled={notifications.pending ||
                    loadingState() === "loading"}
                  class="block w-full cursor-pointer px-4 py-8 text-center text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Switch>
                    <Match
                      when={notifications.pending ||
                        loadingState() === "loading"}
                    >
                      {t`Loading more notifications`}
                    </Match>
                    <Match when={loadingState() === "errored"}>
                      {t`Failed to load more notifications; click to retry`}
                    </Match>
                    <Match when={loadingState() === "loaded"}>
                      {t`Load more notifications`}
                    </Match>
                  </Switch>
                </button>
              </li>
            </Show>
          </ul>
        </>
      )}
    </Show>
  );
}
