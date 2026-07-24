import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.ts";
import type { ActorPreviewCard_actor$key } from "./__generated__/ActorPreviewCard_actor.graphql.ts";
import { FollowButton } from "./FollowButton.tsx";
import { InternalLink } from "./InternalLink.tsx";

export interface ActorPreviewCardProps {
  $actor: ActorPreviewCard_actor$key;
}

export function ActorPreviewCard(props: ActorPreviewCardProps) {
  const { t, i18n } = useLingui();
  const actor = createFragment(
    graphql`
      fragment ActorPreviewCard_actor on Actor
      @argumentDefinitions(
        actingAccountId: { type: "ID", defaultValue: null }
      ) {
        id
        name
        username
        handle
        avatarUrl
        avatarInitials
        bio
        local
        url
        iri
        followsViewer(actingAccountId: $actingAccountId)
        followeesCount: followees {
          totalCount
        }
        followersCount: followers {
          totalCount
        }
        ...FollowButton_actor @arguments(actingAccountId: $actingAccountId)
      }
    `,
    () => props.$actor,
  );

  return (
    <Show keyed when={actor()}>
      {(a) => {
        const actorHref = () => a.url ?? a.iri;
        const actorInternalHref = () =>
          a.local ? `/@${a.username}` : `/${a.handle}`;
        const followingText = () =>
          i18n._(
            msg`${plural(a.followeesCount.totalCount, {
              one: "# following",
              other: "# following",
            })}`,
          );
        const followersText = () =>
          i18n._(
            msg`${plural(a.followersCount.totalCount, {
              one: "# follower",
              other: "# followers",
            })}`,
          );
        return (
          <div class="flex flex-col">
            <div class="flex items-start gap-3 p-4">
              <Avatar class="size-12 shrink-0">
                <InternalLink
                  href={actorHref()}
                  internalHref={actorInternalHref()}
                >
                  <AvatarImage src={a.avatarUrl} class="size-12" />
                  <AvatarFallback class="size-12">
                    {a.avatarInitials}
                  </AvatarFallback>
                </InternalLink>
              </Avatar>
              <div class="flex min-w-0 flex-1 flex-col">
                <Show
                  when={(a.name ?? "").trim() !== ""}
                  fallback={
                    <InternalLink
                      href={actorHref()}
                      internalHref={actorInternalHref()}
                      class="truncate font-semibold"
                    >
                      {a.username}
                    </InternalLink>
                  }
                >
                  <InternalLink
                    href={actorHref()}
                    internalHref={actorInternalHref()}
                    innerHTML={a.name ?? ""}
                    class="truncate font-semibold"
                  />
                </Show>
                <span
                  class="truncate text-sm text-muted-foreground select-all"
                  title={a.handle}
                >
                  {a.handle}
                </span>
              </div>
              <div class="shrink-0">
                <FollowButton $actor={a} />
              </div>
            </div>
            <Show when={(a.bio?.trim() ?? "") !== ""}>
              <div class="px-4 pb-3">
                <div
                  innerHTML={a.bio ?? ""}
                  class="prose prose-sm dark:prose-invert max-w-none break-words line-clamp-4"
                />
              </div>
            </Show>
            <div class="px-4 pb-4 text-sm text-muted-foreground">
              <Show when={a.local} fallback={<span>{followingText()}</span>}>
                <InternalLink
                  href={`/@${a.username}/following`}
                  internalHref={`/@${a.username}/following`}
                >
                  {followingText()}
                </InternalLink>
              </Show>
              {" · "}
              <Show when={a.local} fallback={<span>{followersText()}</span>}>
                <InternalLink
                  href={`/@${a.username}/followers`}
                  internalHref={`/@${a.username}/followers`}
                >
                  {followersText()}
                </InternalLink>
              </Show>
              <Show when={a.followsViewer}>
                {" · "}
                {t`Following you`}
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
