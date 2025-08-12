import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { PostExcerpt } from "../PostExcerpt.tsx";
import type { ReactNotificationCard_notification$key } from "./__generated__/ReactNotificationCard_notification.graphql.ts";
import { NotificationMessage } from "./NotificationMessage.tsx";

interface ReactNotificationCardProps {
  $notification: ReactNotificationCard_notification$key;
}

export function ReactNotificationCard(props: ReactNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment ReactNotificationCard_notification on ReactNotification
      {
        ...NotificationMessage_notification
        post {
          ...PostExcerpt_post
        }
        emoji
        customEmoji {
          name
          imageUrl
        }
      }
    `,
    () => props.$notification,
  );

  return (
    <Show when={notification()}>
      {(notification) => {
        const emojiElement = () => (
          <Show
            when={notification().customEmoji}
            fallback={
              <span class="inline-block text-lg">
                {notification().emoji}
              </span>
            }
          >
            {(customEmoji) => (
              <img
                src={customEmoji().imageUrl}
                alt={customEmoji().name}
                class="inline-block h-5 w-5"
              />
            )}
          </Show>
        );

        return (
          <div class="space-y-4">
            <NotificationMessage
              singleActorMessage={t`${"ACTOR"} reacted to your post with ${"EMOJI"}`}
              multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others reacted to your post with ${"EMOJI"}`}
              $notification={notification()}
              additionalValues={{ EMOJI: () => emojiElement() }}
            />
            <Show when={notification().post}>
              {(post) => <PostExcerpt $post={post()} />}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
