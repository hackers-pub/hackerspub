import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NotificationMessage } from "~/components/notification/NotificationMessage.tsx";
import { QuotedPostCard } from "~/components/QuotedPostCard.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ReactNotificationCard_notification$key } from "./__generated__/ReactNotificationCard_notification.graphql.ts";

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
          ...QuotedPostCard_post
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
    <Show keyed when={notification()}>
      {(notification) => {
        const emojiElement = () => (
          // `keyed`: same Solid stale-accessor race as the `post` gate below.
          <Show
            keyed
            when={notification.customEmoji}
            fallback={
              <span class="inline-block text-lg">
                {notification.emoji}
              </span>
            }
          >
            {(customEmoji) => (
              <img
                src={customEmoji.imageUrl}
                alt={customEmoji.name}
                class="inline-block h-5 w-5"
              />
            )}
          </Show>
        );

        return (
          <div>
            <NotificationMessage
              singleActorMessage={t`${"ACTOR"} reacted to your post with ${"EMOJI"}`}
              multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others reacted to your post with ${"EMOJI"}`}
              $notification={notification}
              additionalValues={{ EMOJI: () => emojiElement() }}
            />
            {
              /* `keyed` avoids a "Stale read from <Show>" race when this
               Relay fragment publishes a snapshot inside `batch()` that
               nulls `post` while descendant work reruns. Reconcile keeps
               the post's identity stable, so `keyed` only re-mounts on
               record change. */
            }
            <Show keyed when={notification.post}>
              {(post) => <QuotedPostCard $post={post} class="-mt-2" />}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
