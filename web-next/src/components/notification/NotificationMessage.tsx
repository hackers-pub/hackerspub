import { graphql } from "relay-runtime";
import type { JSX } from "solid-js";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { NotificationActor } from "../NotificationActor.tsx";
import { Trans } from "../Trans.tsx";
import { NotificationMessage_notification$key } from "./__generated__/NotificationMessage_notification.graphql.ts";

interface NotificationMessageProps {
  singleActorMessage: string;
  multipleActorMessage: string;
  $notification: NotificationMessage_notification$key;
  additionalValues?: Record<string, () => JSX.Element>;
}

/**
 * Generic notification message renderer.
 *
 * @example Basic usage (e.g., Mention)
 * <NotificationMessage
 *   singleActorMessage={t`${"ACTOR"} mentioned you`}
 *   multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others mentioned you`}
 *   $notification={notification()}
 * />
 *
 * @example Extra placeholder (e.g., React)
 * <NotificationMessage
 *   singleActorMessage={t`${"ACTOR"} reacted to your post with ${"EMOJI"}`}
 *   multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others reacted to your post with ${"EMOJI"}`}
 *   $notification={notification()}
 *   additionalValues={{ EMOJI: () => emojiElement() }}
 * />
 */
export function NotificationMessage(props: NotificationMessageProps) {
  const notification = createFragment(
    graphql`
      fragment NotificationMessage_notification on Notification {
        actors {
          edges {
            __typename
          }
        }
        ...NotificationActor_notification
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
                message={props.singleActorMessage}
                values={{
                  ACTOR: () => (
                    <NotificationActor $notification={notification()} />
                  ),
                  ...props.additionalValues,
                }}
              />
            </div>
          </Match>
          <Match when={notification().actors.edges.length > 1}>
            <div class="flex flex-row gap-2 items-center">
              <Trans
                message={props.multipleActorMessage}
                values={{
                  ACTOR: () => (
                    <NotificationActor $notification={notification()} />
                  ),
                  COUNT: () => notification().actors.edges.length - 1,
                  ...props.additionalValues,
                }}
              />
            </div>
          </Match>
        </Switch>
      )}
    </Show>
  );
}
