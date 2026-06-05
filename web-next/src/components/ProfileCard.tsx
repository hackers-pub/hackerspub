import { compactUrl } from "@hackerspub/models/url";
import { graphql } from "relay-runtime";
import { createSignal, For, Show } from "solid-js";
import { createFragment } from "solid-relay";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
import type { ProfileCard_actor$key } from "./__generated__/ProfileCard_actor.graphql.ts";
import { FollowButton } from "./FollowButton.tsx";
import { ProfileActionMenu } from "./ProfileActionMenu.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { Trans } from "./Trans.tsx";

export interface ProfileCardProps {
  $actor: ProfileCard_actor$key;
}

export function ProfileCard(props: ProfileCardProps) {
  const { t, i18n } = useLingui();
  const [bioRef, setBioRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(bioRef);
  const actor = createFragment(
    graphql`
      fragment ProfileCard_actor on Actor {
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
        followeesCount: followees {
          totalCount
        }
        followersCount: followers {
          totalCount
        }
        mutualFollowers(first: 3) {
          totalCount
          edges {
            node {
              id
              username
              rawName
              handle
              avatarUrl
              avatarInitials
              local
              url
              iri
            }
          }
        }
        viewerBlocks
        blocksViewer
        followsViewer
        fields {
          name
          value
        }
        account {
          created
          inviter {
            id
            username
            name
            actor {
              id
              avatarUrl
              avatarInitials
            }
          }
          links {
            name
            handle
            icon
            url
            verified
          }
        }
        ...FollowButton_actor
        ...ProfileActionMenu_actor
      }
    `,
    () => props.$actor,
  );

  return (
    <Show keyed when={actor()}>
      {(actor) => (
        <>
          <div class="p-4">
            <div class="flex items-center gap-4">
              <Avatar
                classList={{
                  "size-16": true,
                  "grayscale": actor.viewerBlocks,
                  "opacity-40": actor.viewerBlocks,
                }}
              >
                <a
                  href={actor.local
                    ? `/@${actor.username}`
                    : actor.url ?? actor.iri}
                  target={actor.local ? undefined : "_blank"}
                >
                  <AvatarImage src={actor.avatarUrl} class="size-16" />
                  <AvatarFallback class="size-16">
                    {actor.avatarInitials}
                  </AvatarFallback>
                </a>
              </Avatar>
              <div class="flex-1">
                <h1 class="text-xl font-semibold">
                  <a
                    innerHTML={actor.name ?? actor.username}
                    href={actor.local
                      ? `/@${actor.username}`
                      : actor.url ?? actor.iri}
                    target={actor.local ? undefined : "_blank"}
                  />
                </h1>
                <div class="text-muted-foreground">
                  <span class="select-all">
                    {actor.handle}
                  </span>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <FollowButton $actor={actor} />
                <Show when={actor.local}>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      as={(triggerProps: Record<string, unknown>) => (
                        <Button
                          variant="ghost"
                          size="sm"
                          class="h-9 w-9 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
                          aria-label={t`Subscribe via RSS`}
                          {...triggerProps}
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke-width="1.5"
                            stroke="currentColor"
                            class="size-4"
                            aria-hidden="true"
                          >
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              d="M12.75 19.5v-.75a7.5 7.5 0 0 0-7.5-7.5H4.5m0-6.75h.75c7.87 0 14.25 6.38 14.25 14.25v.75M6 18.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"
                            />
                          </svg>
                        </Button>
                      )}
                    />
                    <DropdownMenuContent class="min-w-44">
                      <DropdownMenuItem
                        as="a"
                        href={`/@${actor.username}/feed.xml`}
                        class="cursor-pointer"
                      >
                        {t`All posts`}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        as="a"
                        href={`/@${actor.username}/feed.xml?articles`}
                        class="cursor-pointer"
                      >
                        {t`Articles only`}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </Show>
                <ProfileActionMenu $actor={actor} />
              </div>
            </div>
          </div>
          <Show when={actor.viewerBlocks}>
            <div class="px-4 pb-4">
              <div class="rounded-md border border-warning-foreground bg-warning px-3 py-2 text-sm text-warning-foreground">
                {t`You are blocking this user. They can't follow you or see your posts.`}
              </div>
            </div>
          </Show>
          <Show when={actor.blocksViewer}>
            <div class="px-4 pb-4">
              <div class="rounded-md border border-warning-foreground bg-warning px-3 py-2 text-sm text-warning-foreground">
                {t`You are blocked by this user. You can't follow them or see their posts.`}
              </div>
            </div>
          </Show>
          <Show when={(actor.bio?.trim() ?? "") !== ""}>
            <div class="p-4 pt-0">
              <div
                ref={setBioRef}
                innerHTML={actor.bio ?? ""}
                class="mx-auto prose dark:prose-invert"
              />
              <MentionHoverCardLayer state={mentionState} />
            </div>
          </Show>
          <Show
            keyed
            when={actor.account}
            fallback={
              <Show when={(actor.fields?.length ?? 0) > 0}>
                <div class="p-4 pt-0">
                  <ul>
                    <For each={actor.fields ?? []}>
                      {(field) => (
                        <li class="flex flex-row items-center text-sm mb-1">
                          <img
                            src="/icons/web.svg"
                            class="size-3.5 mr-1 dark:invert opacity-65"
                          />
                          <span class="text-muted-foreground mr-1">
                            {field.name}
                          </span>
                          <span innerHTML={field.value}></span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            }
          >
            {(account) => (
              <Show
                when={(account.links?.length ?? 0) > 0}
              >
                <div class="p-4 pt-0">
                  <ul>
                    <For each={account.links ?? []}>
                      {(link) => (
                        <li class="flex flex-row items-center text-sm mb-1">
                          <img
                            src={`/icons/${link.icon.toLowerCase()}.svg`}
                            class="size-3.5 mr-1 dark:invert opacity-65"
                          />
                          <span class="text-muted-foreground mr-1">
                            {link.name}
                          </span>
                          <a href={link.url}>
                            {link.handle ?? compactUrl(link.url)}
                          </a>
                          <Show keyed when={link.verified}>
                            {(verified) => (
                              <Tooltip>
                                <TooltipTrigger>
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke-width="1.5"
                                    stroke="currentColor"
                                    class="size-4 ml-1 stroke-success-foreground cursor-help"
                                  >
                                    <path
                                      stroke-linecap="round"
                                      stroke-linejoin="round"
                                      d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z"
                                    />
                                  </svg>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <Trans
                                    message={t`Verified that this link is owned by ${"OWNER"} ${"RELATIVE_TIME"}`}
                                    values={{
                                      OWNER: () => <strong>{actor.name}
                                      </strong>,
                                      RELATIVE_TIME: () => (
                                        <Timestamp value={verified} />
                                      ),
                                    }}
                                  />
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            )}
          </Show>
          <div class="p-4 pt-0 border-b space-y-3">
            {/* TODO: remove ?. once https://github.com/XiNiHa/solid-relay/issues/59 is resolved */}
            <div class="text-muted-foreground">
              <a
                href={actor.local ? `/@${actor.username}/following` : undefined}
              >
                {i18n._(
                  msg`${
                    plural(actor.followeesCount?.totalCount ?? 0, {
                      one: "# following",
                      other: "# following",
                    })
                  }`,
                )}
              </a>{" "}
              &middot;{" "}
              <a
                href={actor.local ? `/@${actor.username}/followers` : undefined}
              >
                {i18n._(
                  msg`${
                    plural(actor.followersCount?.totalCount ?? 0, {
                      one: "# follower",
                      other: "# followers",
                    })
                  }`,
                )}
              </a>
              <Show when={actor.followsViewer}>
                {" "}
                &middot; {t`Following you`}
              </Show>
            </div>
            <Show when={(actor.mutualFollowers?.totalCount ?? 0) > 0}>
              <div class="flex items-center gap-2">
                <div class="flex -space-x-2">
                  <For each={actor.mutualFollowers?.edges ?? []}>
                    {(edge) => (
                      <a
                        href={edge.node.local
                          ? `/@${edge.node.username}`
                          : edge.node.url ?? edge.node.iri}
                        target={edge.node.local ? undefined : "_blank"}
                        title={edge.node.handle}
                        aria-label={edge.node.handle}
                      >
                        <Avatar class="size-6 ring-2 ring-background">
                          <AvatarImage
                            src={edge.node.avatarUrl}
                            class="size-6"
                          />
                          <AvatarFallback class="size-6 text-xs">
                            {edge.node.avatarInitials}
                          </AvatarFallback>
                        </Avatar>
                      </a>
                    )}
                  </For>
                </div>
                <span class="text-sm text-muted-foreground">
                  {i18n._(
                    msg`${
                      plural(actor.mutualFollowers?.totalCount ?? 0, {
                        one: "Followed by # person you follow",
                        other: "Followed by # people you follow",
                      })
                    }`,
                  )}
                </span>
              </div>
            </Show>
            <Show
              when={actor.account?.inviter != null ||
                actor.account?.created != null}
            >
              <div class="space-y-1 text-sm text-muted-foreground">
                <Show keyed when={actor.account?.inviter}>
                  {(inviter) => (
                    <div class="flex items-center">
                      <a
                        href={`/@${inviter.username}`}
                        class="mr-1.5 shrink-0"
                        aria-label={inviter.name ?? inviter.username}
                      >
                        <Avatar class="size-5">
                          <AvatarImage
                            src={inviter.actor?.avatarUrl}
                            class="size-5"
                          />
                          <AvatarFallback class="size-5 text-[0.625rem]">
                            {inviter.actor?.avatarInitials}
                          </AvatarFallback>
                        </Avatar>
                      </a>
                      <span>
                        <Trans
                          message={t`Invited by ${"INVITER"}`}
                          values={{
                            INVITER: () => (
                              <a
                                href={`/@${inviter.username}`}
                                class="text-foreground hover:underline"
                              >
                                {inviter.name ?? inviter.username}
                              </a>
                            ),
                          }}
                        />
                      </span>
                    </div>
                  )}
                </Show>
                <Show keyed when={actor.account?.created}>
                  {(created) => (
                    <div class="flex items-center">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke-width="1.5"
                        stroke="currentColor"
                        class="size-3.5 mr-1.5 shrink-0"
                      >
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5"
                        />
                      </svg>
                      <span>
                        {i18n._(
                          msg`Joined ${
                            new Date(created).toLocaleDateString(i18n.locale, {
                              year: "numeric",
                              month: "long",
                            })
                          }`,
                        )}
                      </span>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          </div>
        </>
      )}
    </Show>
  );
}
