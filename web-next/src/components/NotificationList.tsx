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
    <Show when={notifications()}>
      {(data) => (
        <>
          <ul class="flex flex-col gap-2 p-4">
            <For each={data().notifications.edges}>
              {(edge) => <NotificationCard $notification={edge.node} />}
            </For>
          </ul>
          <Show when={notifications.hasNext}>
            <div
              on:click={loadingState() === "loading" ? undefined : onLoadMore}
              class="block px-4 py-8 text-center text-muted-foreground cursor-pointer hover:text-primary hover:bg-secondary"
            >
              <Switch>
                <Match
                  when={notifications.pending || loadingState() === "loading"}
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
            </div>
          </Show>
        </>
      )}
    </Show>
  );
}
