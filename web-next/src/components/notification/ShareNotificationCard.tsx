import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { PostExcerpt } from "../PostExcerpt.tsx";
import type { ShareNotificationCard_notification$key } from "./__generated__/ShareNotificationCard_notification.graphql.ts";
import { NotificationMessage } from "./NotificationMessage.tsx";

interface ShareNotificationCardProps {
  $notification: ShareNotificationCard_notification$key;
}

export function ShareNotificationCard(props: ShareNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment ShareNotificationCard_notification on ShareNotification
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
            singleActorMessage={t`${"ACTOR"} shared your post`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others shared your post`}
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
