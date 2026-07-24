import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { FollowNotificationCard_notification$key } from "./__generated__/FollowNotificationCard_notification.graphql.ts";
import { NotificationMessage } from "./NotificationMessage.tsx";

interface FollowNotificationCardProps {
  $notification: FollowNotificationCard_notification$key;
}

export function FollowNotificationCard(props: FollowNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment FollowNotificationCard_notification on FollowNotification {
        ...NotificationMessage_notification
      }
    `,
    () => props.$notification,
  );

  return (
    <Show keyed when={notification()}>
      {(notification) => (
        <NotificationMessage
          singleActorMessage={t`${"ACTOR"} followed you`}
          multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others followed you`}
          $notification={notification}
        />
      )}
    </Show>
  );
}
