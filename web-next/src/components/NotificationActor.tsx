import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import type { NotificationActor_notification$key } from "./__generated__/NotificationActor_notification.graphql.ts";

interface NotificationActorProps {
  $notification: NotificationActor_notification$key;
}

export function NotificationActor(props: NotificationActorProps) {
  const notification = createFragment(
    graphql`
      fragment NotificationActor_notification on Notification {
        actors {
          edges {
            node {
              handle
              name
            }
          }
        }
      }
    `,
    () => props.$notification,
  );

  type Notification = Exclude<
    ReturnType<typeof notification>,
    undefined
  >;

  const firstActor = (
    notification: Notification,
  ) => {
    return notification.actors.edges[0]?.node;
  };

  return (
    <Show when={notification()}>
      {(notification) => (
        <Show when={firstActor(notification())}>
          {(firstActor) => (
            <a href={`/${firstActor().handle}`}>
              <Show
                when={firstActor().name}
                fallback={
                  <span class="font-semibold text-muted-foreground">
                    {firstActor().handle}
                  </span>
                }
              >
                {(name) => (
                  <>
                    <span innerHTML={name()} class="font-semibold" />{" "}
                    <span class="text-muted-foreground">
                      ({firstActor().handle})
                    </span>
                  </>
                )}
              </Show>
            </a>
          )}
        </Show>
      )}
    </Show>
  );
}
