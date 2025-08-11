import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { NotificationActor } from "../NotificationActor.tsx";
import { PostExcerpt } from "../PostExcerpt.tsx";
import { Trans } from "../Trans.tsx";
import type {
  ReactNotificationCard_notification$key,
} from "./__generated__/ReactNotificationCard_notification.graphql.ts";

interface ReactNotificationCardProps {
  $notification: ReactNotificationCard_notification$key;
}

export function ReactNotificationCard(props: ReactNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment ReactNotificationCard_notification on ReactNotification
      {
        ...NotificationActor_notification
        actors {
          edges {
            __typename
          }
        }
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
      {(notification) => (
        <div class="space-y-4">
          <Switch>
            <Match when={notification().actors.edges.length === 1}>
              <div class="flex flex-row gap-2 items-center">
                <Trans
                  message={t`${"ACTOR"} reacted to your post with ${"EMOJI"}`}
                  values={{
                    ACTOR: () => (
                      <NotificationActor $notification={notification()} />
                    ),
                    EMOJI: () => (
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
                    ),
                  }}
                />
              </div>
            </Match>
            <Match when={notification().actors.edges.length > 1}>
              <div class="flex flex-row gap-2 items-center">
                <Trans
                  message={t`${"ACTOR"} and ${"COUNT"} others reacted to your post with ${"EMOJI"}`}
                  values={{
                    ACTOR: () => (
                      <NotificationActor $notification={notification()} />
                    ),
                    COUNT: () => notification().actors.edges.length - 1,
                    EMOJI: () => (
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
                    ),
                  }}
                />
              </div>
            </Match>
          </Switch>

          <Show when={notification().post}>
            {(post) => <PostExcerpt $post={post()} />}
          </Show>
        </div>
      )}
    </Show>
  );
}
