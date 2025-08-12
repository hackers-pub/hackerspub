import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { PostExcerpt } from "../PostExcerpt.tsx";
import type { ReplyNotificationCard_notification$key } from "./__generated__/ReplyNotificationCard_notification.graphql.ts";
import { NotificationMessage } from "./NotificationMessage.tsx";

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
          ...PostExcerpt_post
        }
      }
    `,
    () => props.$notification,
  );

  return (
    <Show when={notification()}>
      {(notification) => (
        <div class="space-y-4">
          <NotificationMessage
            singleActorMessage={t`${"ACTOR"} replied to your post`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others replied to your post`}
            $notification={notification()}
          />
          <Show when={notification().post}>
            {(post) => <PostExcerpt $post={post()} />}
          </Show>
        </div>
      )}
    </Show>
  );
}
