import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import type { NotificationActor_notification$key } from "./__generated__/NotificationActor_notification.graphql.ts";
import { ActorHoverCard } from "./ActorHoverCard.tsx";

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
              username
              local
              name
            }
          }
        }
      }
    `,
    () => props.$notification,
  );

  type Notification = NonNullable<ReturnType<typeof notification>>;

  const firstActor = (notification: Notification) => {
    return notification.actors.edges[0]?.node;
  };

  return (
    <Show keyed when={notification()}>
      {(notification) => (
        <>
          {/* `keyed`: avoid Solid's stale-accessor race when this
             Relay-derived value flips to null inside a `batch()` update. */}
          <Show keyed when={firstActor(notification)}>
            {(firstActor) => (
              <ActorHoverCard handle={firstActor.handle}>
                <a
                  href={`/${
                    firstActor.local
                      ? `@${firstActor.username}`
                      : firstActor.handle
                  }`}
                  class="min-w-0"
                >
                  <Show
                    keyed
                    when={firstActor.name}
                    fallback={
                      <span class="font-semibold text-muted-foreground">
                        {firstActor.handle}
                      </span>
                    }
                  >
                    {(name) => (
                      <span class="inline min-w-0">
                        <span innerHTML={name} class="font-semibold" />{" "}
                        <span
                          class="break-all text-muted-foreground"
                          title={firstActor.handle}
                        >
                          ({firstActor.handle})
                        </span>
                      </span>
                    )}
                  </Show>
                </a>
              </ActorHoverCard>
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
