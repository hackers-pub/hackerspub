import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { PostExcerpt } from "../PostExcerpt.tsx";
import type { QuoteNotificationCard_notification$key } from "./__generated__/QuoteNotificationCard_notification.graphql.ts";
import { NotificationMessage } from "./NotificationMessage.tsx";

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
            singleActorMessage={t`${"ACTOR"} quoted your post`}
            multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others quoted your post`}
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
