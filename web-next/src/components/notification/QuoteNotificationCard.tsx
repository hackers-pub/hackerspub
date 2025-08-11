import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { NotificationActor } from "../NotificationActor.tsx";
import { PostExcerpt } from "../PostExcerpt.tsx";
import { Trans } from "../Trans.tsx";
import type {
  QuoteNotificationCard_notification$key,
} from "./__generated__/QuoteNotificationCard_notification.graphql.ts";

interface QuoteNotificationCardProps {
  $notification: QuoteNotificationCard_notification$key;
}

export function QuoteNotificationCard(props: QuoteNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment QuoteNotificationCard_notification on QuoteNotification
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
                  message={t`${"ACTOR"} quoted your post`}
                  values={{
                    ACTOR: () => (
                      <NotificationActor $notification={notification()} />
                    ),
                  }}
                />
              </div>
            </Match>
            <Match when={notification().actors.edges.length > 1}>
              <div class="flex flex-row gap-2 items-center">
                <Trans
                  message={t`${"ACTOR"} and ${"COUNT"} others quoted your post`}
                  values={{
                    ACTOR: () => (
                      <NotificationActor $notification={notification()} />
                    ),
                    COUNT: () => notification().actors.edges.length - 1,
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
