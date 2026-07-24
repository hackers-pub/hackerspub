import { Navigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import { AdminTabs } from "~/components/AdminTabs.tsx";
import { ModerationSubTabs } from "~/components/admin/ModerationSubTabs.tsx";
import { Title } from "~/components/Title.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { Badge } from "~/components/ui/badge.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";
import type { sanctionedPageQuery } from "./__generated__/sanctionedPageQuery.graphql.ts";

const sanctionedPageQuery = graphql`
  query sanctionedPageQuery {
    viewer {
      moderator
    }
    sanctionedActors {
      id
      name
      handle
      username
      local
      avatarUrl
      avatarInitials
    }
  }
`;

const loadSanctionedPageQuery = routePreloadedQuery(
  () =>
    loadQuery<sanctionedPageQuery>(
      useRelayEnvironment()(),
      sanctionedPageQuery,
      {},
    ),
  "loadSanctionedPageQuery",
);

export default function ModerationSanctionedPage() {
  const { t } = useLingui();
  const data = createStablePreloadedQuery<sanctionedPageQuery>(
    sanctionedPageQuery,
    () => loadSanctionedPageQuery(),
  );

  const profileHref = (actor: {
    local: boolean;
    username: string;
    handle: string;
  }) => `/${actor.local ? `@${actor.username}` : actor.handle}`;

  return (
    <WideContainer class="p-4">
      <Title>{t`Hackers' Pub: Admin · Sanctioned actors`}</Title>
      <Show keyed when={data()}>
        {(data) => (
          <Show
            when={data.viewer?.moderator}
            fallback={<Navigate href="/sign?next=%2Fadmin%2Fmoderation" />}
          >
            <AdminTabs selected="moderation" />
            <ModerationSubTabs selected="sanctioned" />
            <h1 class="mb-1 mt-4 text-2xl font-semibold tracking-tight">
              {t`Sanctioned actors`}
            </h1>
            <p class="mb-4 text-sm text-muted-foreground">
              {t`Actors currently under an active suspension or federation block. Expired suspensions drop off automatically.`}
            </p>

            <Show
              when={(data.sanctionedActors?.length ?? 0) > 0}
              fallback={
                <p class="px-4 py-12 text-center text-muted-foreground">
                  {t`No actors are currently sanctioned.`}
                </p>
              }
            >
              <ul class="divide-y divide-solid rounded-md border">
                <For each={data.sanctionedActors ?? []}>
                  {(actor) => (
                    <li class="flex items-center gap-3 px-4 py-3">
                      <Avatar class="size-10 shrink-0">
                        <a href={profileHref(actor)}>
                          <AvatarImage src={actor.avatarUrl} class="size-10" />
                          <AvatarFallback class="size-10">
                            {actor.avatarInitials}
                          </AvatarFallback>
                        </a>
                      </Avatar>
                      <div class="flex min-w-0 grow flex-col">
                        <Show
                          when={(actor.name ?? "").trim() !== ""}
                          fallback={
                            <a
                              href={profileHref(actor)}
                              class="truncate font-medium hover:underline"
                            >
                              {actor.username}
                            </a>
                          }
                        >
                          <a
                            href={profileHref(actor)}
                            class="truncate font-medium hover:underline"
                            innerHTML={actor.name ?? ""}
                          />
                        </Show>
                        <span
                          class="truncate text-sm text-muted-foreground"
                          title={actor.handle}
                        >
                          {actor.handle}
                        </span>
                      </div>
                      <Badge variant="error">{t`Suspended`}</Badge>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        )}
      </Show>
    </WideContainer>
  );
}
