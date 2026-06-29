import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { QuotedPostCard } from "~/components/QuotedPostCard.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { QuoteNotificationCard_notification$key } from "./__generated__/QuoteNotificationCard_notification.graphql.ts";

interface QuoteNotificationCardProps {
  $notification: QuoteNotificationCard_notification$key;
}

export function QuoteNotificationCard(props: QuoteNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment QuoteNotificationCard_notification on QuoteNotification
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
    <Show keyed when={notification()}>
      {(notification) => (
        <div>
          <NotificationMessage
            singleActorMessage={t`${"ACTOR"} quoted your post`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others quoted your post`}
            $notification={notification}
          />
          {
            /* `keyed` avoids a "Stale read from <Show>" race when this Relay
             fragment publishes a snapshot inside `batch()` that nulls
             `post` while descendant work reruns. Reconcile keeps the post's
             identity stable, so `keyed` only re-mounts on record change. */
          }
          <Show keyed when={notification.post}>
            {(post) => (
              <QuotedPostCard
                $post={post}
                linkPreview
                class="-mt-2"
              />
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
