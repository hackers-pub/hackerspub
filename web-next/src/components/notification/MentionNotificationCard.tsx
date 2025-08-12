import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { PostExcerpt } from "../PostExcerpt.tsx";
import type {
  MentionNotificationCard_notification$key,
} from "./__generated__/MentionNotificationCard_notification.graphql.ts";
import { NotificationMessage } from "./NotificationMessage.tsx";

interface MentionNotificationCardProps {
  $notification: MentionNotificationCard_notification$key;
}

export function MentionNotificationCard(props: MentionNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment MentionNotificationCard_notification on MentionNotification
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
            singleActorMessage={t`${"ACTOR"} mentioned you`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others mentioned you`}
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
