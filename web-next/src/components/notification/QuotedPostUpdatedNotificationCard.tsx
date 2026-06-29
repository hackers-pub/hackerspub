import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { QuotedPostCard } from "~/components/QuotedPostCard.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { QuotedPostUpdatedNotificationCard_notification$key } from "./__generated__/QuotedPostUpdatedNotificationCard_notification.graphql.ts";

interface QuotedPostUpdatedNotificationCardProps {
  $notification: QuotedPostUpdatedNotificationCard_notification$key;
}

export function QuotedPostUpdatedNotificationCard(
  props: QuotedPostUpdatedNotificationCardProps,
) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment QuotedPostUpdatedNotificationCard_notification on QuotedPostUpdatedNotification
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
            singleActorMessage={t`${"ACTOR"} updated a post you quoted`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others updated a post you quoted`}
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
