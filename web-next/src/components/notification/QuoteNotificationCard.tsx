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
    <Show when={notification()}>
      {(notification) => (
        <div>
          <NotificationMessage
            singleActorMessage={t`${"ACTOR"} quoted your post`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others quoted your post`}
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
