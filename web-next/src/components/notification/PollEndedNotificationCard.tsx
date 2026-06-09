import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { QuotedPostCard } from "~/components/QuotedPostCard.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { PollEndedNotificationCard_notification$key } from "./__generated__/PollEndedNotificationCard_notification.graphql.ts";

interface PollEndedNotificationCardProps {
  $notification: PollEndedNotificationCard_notification$key;
}

export function PollEndedNotificationCard(
  { $notification }: PollEndedNotificationCardProps,
) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment PollEndedNotificationCard_notification on PollEndedNotification
      {
        ...NotificationMessage_notification
        post {
          ...QuotedPostCard_post
        }
      }
    `,
    () => $notification,
  );

  return (
    <Show keyed when={notification()}>
      {(notification) => (
        <div>
          <NotificationMessage
            singleActorMessage={t`${"ACTOR"}'s poll ended`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others' polls ended`}
            $notification={notification}
          />
          <Show keyed when={notification.post}>
            {(post) => <QuotedPostCard $post={post} class="-mt-2" />}
          </Show>
        </div>
      )}
    </Show>
  );
}
