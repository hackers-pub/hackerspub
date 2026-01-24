import { A, useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconBell from "~icons/lucide/bell";
import IconList from "~icons/lucide/list";
import IconSearch from "~icons/lucide/search";
import IconSquarePen from "~icons/lucide/square-pen";
import type { Navigation_signedAccount$key } from "./__generated__/Navigation_signedAccount.graphql.ts";
import { Footer } from "./Footer.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";

export interface NavigationProps {
  $signedAccount: Navigation_signedAccount$key;
}

export function Navigation(props: NavigationProps) {
  const { t } = useLingui();
  const { open: openNoteCompose } = useNoteCompose();
  const location = useLocation();

  const signedAccount = createFragment(
    graphql`
      fragment Navigation_signedAccount on Account {
        username
        avatarUrl
      }
    `,
    () => props.$signedAccount,
  );

  const isActive = (path: string) => {
    return location.pathname === path ||
      location.pathname.startsWith(path + "/");
  };

  return (
    <Show when={signedAccount()} keyed>
      {(account) => (
        <nav
          class="fixed sm:flex sm:flex-col z-50 border-border bg-background/95 bottom-0 left-0 right-0 border-t sm:sticky sm:top-0 sm:h-screen sm:w-16 sm:shrink-0 sm:border-t-0 sm:border-r lg:w-50 sm:py-3"
          role="navigation"
          aria-label={t`Main navigation`}
        >
          <A
            href="/"
            class="hidden sm:flex items-center justify-center p-3 lg:px-4"
            aria-label={t`Home`}
          >
            <img
              src="/pubnyan-normal-border.svg"
              alt="Hackers' Pub"
              class="size-9 lg:hidden"
            />
            <picture class="hidden lg:block">
              <source
                srcset="/logo-dark.svg"
                media="(prefers-color-scheme: dark)"
              />
              <img
                src="/logo-light.svg"
                alt="Hackers' Pub"
                class="h-10"
              />
            </picture>
          </A>
          <ul class="flex flex-1 h-13 items-center justify-around px-2 sm:h-auto sm:flex-col sm:justify-start sm:gap-1 sm:px-0 sm:py-2 ">
            <li class="flex-1 sm:flex-none sm:w-full">
              <A
                href="/feed"
                class="flex items-center justify-center py-3 text-muted-foreground transition-colors sm:p-3 lg:justify-start lg:gap-3 lg:rounded-full lg:hover:bg-accent"
                classList={{
                  "text-foreground": isActive("/feed"),
                }}
                aria-label={t`Feed`}
                aria-current={isActive("/feed") ? "page" : undefined}
              >
                <IconList class="size-6 shrink-0" aria-hidden="true" />
                <span class="hidden lg:inline">{t`Feed`}</span>
              </A>
            </li>
            <li class="flex-1 sm:flex-none sm:w-full">
              <A
                href="/notifications"
                class="flex items-center justify-center py-3 text-muted-foreground transition-colors sm:p-3 lg:justify-start lg:gap-3 lg:rounded-full lg:hover:bg-accent"
                classList={{
                  "text-foreground": isActive("/notifications"),
                }}
                aria-label={t`Notifications`}
                aria-current={isActive("/notifications") ? "page" : undefined}
              >
                <IconBell class="size-6 shrink-0" aria-hidden="true" />
                <span class="hidden lg:inline">{t`Notifications`}</span>
              </A>
            </li>
            <li class="flex-1 sm:hidden">
              <button
                type="button"
                onClick={openNoteCompose}
                class="flex w-full items-center justify-center py-3 text-muted-foreground transition-colors sm:p-3"
                aria-label={t`Create Note`}
              >
                <IconSquarePen class="size-6 shrink-0" aria-hidden="true" />
              </button>
            </li>
            <li class="flex-1 sm:flex-none sm:w-full">
              <A
                href="/search"
                class="flex items-center justify-center py-3 text-muted-foreground transition-colors sm:p-3 lg:justify-start lg:gap-3 lg:rounded-full lg:hover:bg-accent"
                classList={{
                  "text-foreground": isActive("/search"),
                }}
                aria-label={t`Search`}
                aria-current={isActive("/search") ? "page" : undefined}
              >
                <IconSearch class="size-6 shrink-0" aria-hidden="true" />
                <span class="hidden lg:inline">{t`Search`}</span>
              </A>
            </li>
            <li class="flex-1 sm:flex-none sm:w-full">
              <A
                href={`/@${account.username}`}
                class="flex items-center justify-center py-3 sm:p-3 lg:justify-start lg:gap-3 lg:rounded-full lg:hover:bg-accent"
                aria-label={t`Profile`}
                aria-current={location.pathname === `/@${account.username}`
                  ? "page"
                  : undefined}
              >
                <Avatar
                  class="size-6 shrink-0"
                  classList={{
                    "ring-2 ring-foreground": location.pathname ===
                      `/@${account.username}`,
                  }}
                >
                  <AvatarImage src={account.avatarUrl} alt={account.username} />
                  <AvatarFallback>
                    {account.username.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span class="hidden lg:inline">{t`Profile`}</span>
              </A>
            </li>
            <li class="hidden sm:flex w-full px-2 mt-5">
              <button
                type="button"
                onClick={openNoteCompose}
                class="flex lg:flex-1 items-center justify-center p-3 rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
                aria-label={t`Create Note`}
              >
                <IconSquarePen class="size-5" aria-hidden="true" />
              </button>
            </li>
          </ul>
          <Footer class="hidden lg:block" />
        </nav>
      )}
    </Show>
  );
}
