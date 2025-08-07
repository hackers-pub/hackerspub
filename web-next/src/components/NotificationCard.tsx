import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";

import { ParentProps } from "solid-js";
import type { NotificationCard_notification$key } from "./__generated__/NotificationCard_notification.graphql.ts";
import { FollowNotificationCard } from "./notification/FollowNotificationCard.tsx";

export interface NotificationCardProps {
  $notification: NotificationCard_notification$key;
}

export function NotificationCard(props: NotificationCardProps) {
  const notification = createFragment(
    graphql`
      fragment NotificationCard_notification on Notification
      {
        __typename
        ...FollowNotificationCard_notification
      }
    `,
    () => props.$notification,
  );

  return (
    <Show when={notification()}>
      {(notification) => (
        <NotificationContainer>
          <Switch
            fallback={
              <p>Unknown notification type. {notification().__typename}</p>
            }
          >
            <Match when={notification().__typename === "FollowNotification"}>
              <FollowNotificationCard $notification={notification()} />
            </Match>
          </Switch>
        </NotificationContainer>
      )}
    </Show>
  );
}

function NotificationContainer(props: ParentProps) {
  return (
    <li class="border-1 border-gray-800 p-4">
      {props.children}
    </li>
  );
}
