import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import type { NotificationActor_notification$key } from "./__generated__/NotificationActor_notification.graphql.ts";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";

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
              avatarUrl
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
            <a
              href={`/${firstActor().handle}`}
              class="flex flex-row gap-1 items-center"
            >
              <Avatar class="w-[2rem] h-[2rem]">
                <Show
                  when={firstActor().avatarUrl}
                  fallback={<AvatarFallback />}
                >
                  {(avatarUrl) => <AvatarImage src={avatarUrl()} />}
                </Show>
              </Avatar>
              <Show when={firstActor().name}>
                {(name) => <span>{name()}</span>}
              </Show>
              <span class="text-gray-500">({firstActor().handle})</span>
            </a>
          )}
        </Show>
      )}
    </Show>
  );
}
