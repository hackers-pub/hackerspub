import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { Excerpt } from "../Excerpt.tsx";
import { NotificationActor } from "../NotificationActor.tsx";
import { Trans } from "../Trans.tsx";
import type {
  ReplyNotificationCard_notification$key,
} from "./__generated__/ReplyNotificationCard_notification.graphql.ts";

interface ReplyNotificationCardProps {
  $notification: ReplyNotificationCard_notification$key;
}

export function ReplyNotificationCard(props: ReplyNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment ReplyNotificationCard_notification on ReplyNotification
      {
        ...NotificationActor_notification
        actors {
          edges {
            __typename
          }
        }
        post {
          url
          content
          iri
          language
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
                  message={t`${"ACTOR"} replied to your post`}
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
                  message={t`${"ACTOR"} and ${"COUNT"} others replied to your post`}
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
            {(post) => (
              <a
                href={post().url ?? post().iri}
                class="block mt-4 p-3 bg-stone-50 dark:bg-stone-900 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
              >
                <Excerpt
                  html={post().content}
                  lang={post().language}
                />
              </a>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
