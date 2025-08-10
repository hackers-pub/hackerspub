import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";

import type { NotificationCard_notification$key } from "./__generated__/NotificationCard_notification.graphql.ts";
import { FollowNotificationCard } from "./notification/FollowNotificationCard.tsx";
import { MentionNotificationCard } from "./notification/MentionNotificationCard.tsx";

export interface NotificationCardProps {
  $notification: NotificationCard_notification$key;
}

export function NotificationCard(props: NotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment NotificationCard_notification on Notification
      {
        __typename
        ...FollowNotificationCard_notification
        ...MentionNotificationCard_notification
      }
    `,
    () => props.$notification,
  );

  return (
    <Show when={notification()}>
      {(notification) => (
        <li class="border-1 border-gray-800 p-4">
          <Switch
            fallback={
              <p>
                {t`Unknown notification type. ${notification().__typename}`}
              </p>
            }
          >
            <Match when={notification().__typename === "FollowNotification"}>
              <FollowNotificationCard $notification={notification()} />
            </Match>
            <Match when={notification().__typename === "MentionNotification"}>
              <MentionNotificationCard $notification={notification()} />
            </Match>
          </Switch>
        </li>
      )}
    </Show>
  );
}
