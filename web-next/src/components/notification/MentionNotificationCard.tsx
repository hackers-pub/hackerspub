import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { QuotedPostCard } from "~/components/QuotedPostCard.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { MentionNotificationCard_notification$key } from "./__generated__/MentionNotificationCard_notification.graphql.ts";

interface MentionNotificationCardProps {
  $notification: MentionNotificationCard_notification$key;
}

export function MentionNotificationCard(props: MentionNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment MentionNotificationCard_notification on MentionNotification {
        ...NotificationMessage_notification
        post {
          ...QuotedPostCard_post
        }
      }
    `,
    () => props.$notification,
  );

  return (
    <Show keyed when={notification()}>
      {(notification) => (
        <div>
          <NotificationMessage
            singleActorMessage={t`${"ACTOR"} mentioned you`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others mentioned you`}
            $notification={notification}
          />
          {/* `keyed` avoids a "Stale read from <Show>" race when this Relay
             fragment publishes a snapshot inside `batch()` that nulls
             `post` while descendant work reruns. Reconcile keeps the post's
             identity stable, so `keyed` only re-mounts on record change. */}
          <Show keyed when={notification.post}>
            {(post) => (
              <QuotedPostCard $post={post} linkPreview class="-mt-2" />
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
