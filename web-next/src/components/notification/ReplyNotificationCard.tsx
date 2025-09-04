import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { QuotedPostCard } from "~/components/QuotedPostCard.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ReplyNotificationCard_notification$key } from "./__generated__/ReplyNotificationCard_notification.graphql.ts";

interface ReplyNotificationCardProps {
  $notification: ReplyNotificationCard_notification$key;
}

export function ReplyNotificationCard(props: ReplyNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment ReplyNotificationCard_notification on ReplyNotification
      {
        ...NotificationMessage_notification
        post {
          ...QuotedPostCard_post
        }
      }
    `,
    () => props.$notification,
  );

  return (
    <Show when={notification()}>
      {(notification) => (
        <div>
          <NotificationMessage
            singleActorMessage={t`${"ACTOR"} replied to your post`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others replied to your post`}
            $notification={notification()}
          />
          <Show when={notification().post}>
            {(post) => <QuotedPostCard $post={post()} class="-mt-2" />}
          </Show>
        </div>
      )}
    </Show>
  );
}
