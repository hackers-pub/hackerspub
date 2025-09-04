import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { QuotedPostCard } from "~/components/QuotedPostCard.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type {
  MentionNotificationCard_notification$key,
} from "./__generated__/MentionNotificationCard_notification.graphql.ts";

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
            singleActorMessage={t`${"ACTOR"} mentioned you`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others mentioned you`}
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
