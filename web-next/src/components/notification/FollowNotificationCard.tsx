import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { NotificationActor } from "../NotificationActor.tsx";
import { Trans } from "../Trans.tsx";
import type {
  FollowNotificationCard_notification$key,
} from "./__generated__/FollowNotificationCard_notification.graphql.ts";

interface FollowNotificationCardProps {
  $notification: FollowNotificationCard_notification$key;
}

export function FollowNotificationCard(props: FollowNotificationCardProps) {
  const { t } = useLingui();
  const notification = createFragment(
    graphql`
      fragment FollowNotificationCard_notification on FollowNotification
      {
        ...NotificationActor_notification
        actors {
          edges {
            __typename
          }
        }
      }
    `,
    () => props.$notification,
  );

  return (
    <Show when={notification()}>
      {(notification) => (
        <Switch>
          <Match when={notification().actors.edges.length === 1}>
            <div class="flex flex-row gap-2 items-center">
              <Trans
                message={t`${"ACTOR"} followed you`}
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
                message={t`${"ACTOR"} and ${"COUNT"} others followed you`}
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
      )}
    </Show>
  );
}
