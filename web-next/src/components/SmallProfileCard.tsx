import { graphql } from "relay-runtime";
import { createSignal, type JSX, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
import type { SmallProfileCard_actor$key } from "./__generated__/SmallProfileCard_actor.graphql.ts";
import { ActorHoverCard } from "./ActorHoverCard.tsx";
import { FollowButton } from "./FollowButton.tsx";

export interface SmallProfileCardProps {
  $actor: SmallProfileCard_actor$key;
  rightAction?: JSX.Element;
}

export function SmallProfileCard(props: SmallProfileCardProps) {
  const [bioRef, setBioRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(bioRef);
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
    <Show keyed when={actor()}>
      {(actor) => (
        <div class="flex flex-col gap-4 p-4">
          <div class="flex min-w-0 flex-row items-start gap-4">
            <ActorHoverCard handle={actor.handle} class="shrink-0">
              <Avatar class="size-16 shrink-0">
                <a
                  href={`/${actor.local ? `@${actor.username}` : actor.handle}`}
                >
                  <AvatarImage src={actor.avatarUrl} class="size-16" />
                </a>
              </Avatar>
            </ActorHoverCard>
            <div class="flex min-w-0 flex-1 flex-col">
              <ActorHoverCard handle={actor.handle}>
                <Show
                  when={(actor.name ?? "").trim() !== ""}
                  fallback={
                    <a
                      href={`/${
                        actor.local ? `@${actor.username}` : actor.handle
                      }`}
                      class="truncate text-lg font-semibold"
                    >
                      {actor.username}
                    </a>
                  }
                >
                  <a
                    href={`/${
                      actor.local ? `@${actor.username}` : actor.handle
                    }`}
                    innerHTML={actor.name ?? ""}
                    class="truncate text-lg font-semibold"
                  />
                </Show>
              </ActorHoverCard>
              <span
                class="truncate text-muted-foreground select-all"
                title={actor.handle}
              >
                {actor.handle}
              </span>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <FollowButton $actor={actor} />
              {props.rightAction}
            </div>
          </div>
          <Show keyed when={actor.bio}>
            {(bio) => (
              <div
                ref={setBioRef}
                innerHTML={bio}
                class="prose dark:prose-invert break-words"
              >
              </div>
            )}
          </Show>
          <MentionHoverCardLayer state={mentionState} />
        </div>
      )}
    </Show>
  );
}
