import { A } from "@solidjs/router";
import { unescape } from "es-toolkit/string";
import { graphql } from "relay-runtime";
import type { JSX } from "solid-js";
import { For, Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { ActorHoverCard } from "~/components/ActorHoverCard.tsx";
import { Trans } from "~/components/Trans.tsx";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import type { NotificationMessage_notification$key } from "./__generated__/NotificationMessage_notification.graphql.ts";

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
 *   $notification={notification}
 * />
 *
 * @example Extra placeholder (e.g., React)
 * <NotificationMessage
 *   singleActorMessage={t`${"ACTOR"} reacted to your post with ${"EMOJI"}`}
 *   multipleActorMessage={t`${"ACTOR"} and ${"COUNT"} others reacted to your post with ${"EMOJI"}`}
 *   $notification={notification}
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
            node {
              avatarUrl
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

  const firstActor = (notification: Notification) =>
    notification.actors.edges[0]?.node;

  const actorElement = (notification: Notification) => {
    const actor = firstActor(notification);
    if (actor == null) return null;
    const href = `/${actor.local ? `@${actor.username}` : actor.handle}`;
    return (
      <ActorHoverCard handle={actor.handle}>
        <a href={href} class="min-w-0">
          <Show
            keyed
            when={actor.name}
            fallback={
              <span class="font-semibold text-muted-foreground">
                {actor.handle}
              </span>
            }
          >
            {(name) => (
              <span class="inline min-w-0">
                <span innerHTML={name} class="font-semibold" />{" "}
                <span
                  class="break-all text-muted-foreground"
                  title={actor.handle}
                >
                  ({actor.handle})
                </span>
              </span>
            )}
          </Show>
        </a>
      </ActorHoverCard>
    );
  };

  return (
    <Show keyed when={notification()}>
      {(notification) => (
        <div class="m-4 flex flex-row gap-4">
          <div class="group flex shrink-0 -space-x-8 hover:-space-x-5">
            <For each={notification.actors.edges.slice(0, 4).toReversed()}>
              {({ node }) => (
                <ActorHoverCard
                  handle={node.handle}
                  class="z-0 hover:z-10 transition-all duration-300 ease-out motion-reduce:transition-none"
                >
                  <Avatar
                    as={A}
                    href={node.local ? `/@${node.username}` : `/${node.handle}`}
                    preload={false}
                  >
                    <AvatarImage
                      src={node.avatarUrl}
                      alt={
                        node.name == null
                          ? node.handle
                          : `${unescape(node.name)} (${node.handle})`
                      }
                    />
                  </Avatar>
                </ActorHoverCard>
              )}
            </For>
          </div>
          <Switch>
            <Match when={notification.actors.edges.length === 1}>
              <div class="min-w-0 leading-6">
                <Trans
                  message={props.singleActorMessage}
                  values={{
                    ACTOR: () => actorElement(notification),
                    ...props.additionalValues,
                  }}
                />
              </div>
            </Match>
            <Match when={notification.actors.edges.length > 1}>
              <div class="min-w-0 leading-6">
                <Trans
                  message={props.multipleActorMessage}
                  values={{
                    ACTOR: () => actorElement(notification),
                    COUNT: () => notification.actors.edges.length - 1,
                    ...props.additionalValues,
                  }}
                />
              </div>
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  );
}
