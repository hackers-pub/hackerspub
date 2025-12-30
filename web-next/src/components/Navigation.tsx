import { A, useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import IconBell from "~icons/lucide/bell";
import IconList from "~icons/lucide/list";
import IconSearch from "~icons/lucide/search";
import IconSquarePen from "~icons/lucide/square-pen";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { Navigation_signedAccount$key } from "./__generated__/Navigation_signedAccount.graphql.ts";
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
          class="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
          role="navigation"
          aria-label={t`Main navigation`}
        >
          <ul class="flex h-13 items-center justify-around px-2">
            <li class="flex-1">
              <A
                href="/feed"
                class="flex items-center justify-center py-3 text-muted-foreground transition-colors"
                classList={{
                  "text-foreground": isActive("/feed"),
                }}
                aria-label={t`Feed`}
                aria-current={isActive("/feed") ? "page" : undefined}
              >
                <IconList class="size-6" aria-hidden="true" />
              </A>
            </li>
            <li class="flex-1">
              <A
                href="/notifications"
                class="flex items-center justify-center py-3 text-muted-foreground transition-colors"
                classList={{
                  "text-foreground": isActive("/notifications"),
                }}
                aria-label={t`Notifications`}
                aria-current={isActive("/notifications") ? "page" : undefined}
              >
                <IconBell class="size-6" aria-hidden="true" />
              </A>
            </li>
            <li class="flex-1">
              <button
                type="button"
                onClick={openNoteCompose}
                class="flex w-full items-center justify-center py-3 text-muted-foreground transition-colors"
                aria-label={t`Create Note`}
              >
                <IconSquarePen class="size-6" aria-hidden="true" />
              </button>
            </li>
            <li class="flex-1">
              <A
                href="/search"
                class="flex items-center justify-center py-3 text-muted-foreground transition-colors"
                classList={{
                  "text-foreground": isActive("/search"),
                }}
                aria-label={t`Search`}
                aria-current={isActive("/search") ? "page" : undefined}
              >
                <IconSearch class="size-6" aria-hidden="true" />
              </A>
            </li>
            <li class="flex-1">
              <A
                href={`/@${account.username}`}
                class="flex items-center justify-center py-3"
                aria-label={t`Profile`}
                aria-current={location.pathname === `/@${account.username}`
                  ? "page"
                  : undefined}
              >
                <Avatar
                  class="size-6"
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
              </A>
            </li>
          </ul>
        </nav>
      )}
    </Show>
  );
}
