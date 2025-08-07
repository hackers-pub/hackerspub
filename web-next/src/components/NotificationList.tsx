import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import { createFragment } from "solid-relay";
import type { NotificationList_account$key } from "./__generated__/NotificationList_account.graphql.ts";
import { NotificationCard } from "./NotificationCard.tsx";

export interface NotificationListProps {
  $account: NotificationList_account$key;
}

export function NotificationList(props: NotificationListProps) {
  const account = createFragment(
    graphql`
      fragment NotificationList_account on Account
      {
        notifications {
          edges {
            node {
              ...NotificationCard_notification
            }
          }
        }
      }
    `,
    () => props.$account,
  );

  return (
    <Show when={account()}>
      {(account) => (
        <ul class="flex flex-col gap-2 p-4">
          <For each={account().notifications.edges}>
            {(edge) => <NotificationCard $notification={edge.node} />}
          </For>
        </ul>
      )}
    </Show>
  );
}
