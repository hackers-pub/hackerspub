import { graphql } from "relay-runtime";
import type { Component } from "solid-js";
import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { createFragment } from "solid-relay";
import type {
  NotificationCard_notification$data,
  NotificationCard_notification$key,
} from "./__generated__/NotificationCard_notification.graphql.ts";
import { FollowNotificationCard } from "./notification/FollowNotificationCard.tsx";
import { MentionNotificationCard } from "./notification/MentionNotificationCard.tsx";
import { QuoteNotificationCard } from "./notification/QuoteNotificationCard.tsx";
import { ReactNotificationCard } from "./notification/ReactNotificationCard.tsx";
import { ReplyNotificationCard } from "./notification/ReplyNotificationCard.tsx";
import { ShareNotificationCard } from "./notification/ShareNotificationCard.tsx";

export interface NotificationCardProps {
  $notification: NotificationCard_notification$key;
}

// FIXME: NotificationCard type is not exported from the generated file
const notificationCards: Readonly<
  Record<
    string,
    Component<{ $notification: NotificationCard_notification$data }>
  >
> = {
  FollowNotification: FollowNotificationCard,
  MentionNotification: MentionNotificationCard,
  ReactNotification: ReactNotificationCard,
  QuoteNotification: QuoteNotificationCard,
  ReplyNotification: ReplyNotificationCard,
  ShareNotification: ShareNotificationCard,
};

export function NotificationCard(props: NotificationCardProps) {
  const notification = createFragment(
    graphql`
      fragment NotificationCard_notification on Notification
      {
        __typename
        ...FollowNotificationCard_notification
        ...MentionNotificationCard_notification
        ...ReactNotificationCard_notification
        ...QuoteNotificationCard_notification
        ...ReplyNotificationCard_notification
        ...ShareNotificationCard_notification
      }
    `,
    () => props.$notification,
  );

  return (
    <Show when={notification()}>
      {(notification) => (
        <li class="border-b last:border-0">
          <Dynamic
            component={notificationCards[notification().__typename]}
            $notification={notification()}
          />
        </li>
      )}
    </Show>
  );
}
