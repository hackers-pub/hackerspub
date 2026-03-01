import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import type { SmallProfileCard_actor$key } from "./__generated__/SmallProfileCard_actor.graphql.ts";
import { FollowButton } from "./FollowButton.tsx";

export interface SmallProfileCardProps {
  $actor: SmallProfileCard_actor$key;
}

export function SmallProfileCard(props: SmallProfileCardProps) {
  const actor = createFragment(
    graphql`
      fragment SmallProfileCard_actor on Actor {
        avatarUrl
        name
        bio
        handle
        local
        username
        ...FollowButton_actor
      }
    `,
    () => props.$actor,
  );

  return (
    <Show when={actor()}>
      {(actor) => (
        <div class="flex flex-col gap-4 p-4">
          <div class="flex flex-row gap-4 items-center">
            <Avatar class="size-16">
              <a
                href={`/${
                  actor().local ? `@${actor().username}` : actor().handle
                }`}
              >
                <AvatarImage src={actor().avatarUrl} class="size-16" />
              </a>
            </Avatar>
            <div class="flex flex-col flex-1">
              <a
                href={`/${
                  actor().local ? `@${actor().username}` : actor().handle
                }`}
                innerHTML={actor().name ?? actor().username}
                class="font-semibold text-lg"
              />
              <span class="text-muted-foreground select-all">
                {actor().handle}
              </span>
            </div>
            <FollowButton $actor={actor()} />
          </div>
          <Show when={actor().bio}>
            {(bio) => (
              <div innerHTML={bio()} class="prose dark:prose-invert"></div>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
