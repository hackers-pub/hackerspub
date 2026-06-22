import { A, useLocation } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createEffect, createMemo, For, Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import IconCheck from "~icons/lucide/check";
import IconChevronsUpDown from "~icons/lucide/chevrons-up-down";
import IconShieldCheck from "~icons/lucide/shield-check";
import IconUndo2 from "~icons/lucide/undo-2";
import { Button } from "~/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/ui/sidebar.tsx";
import { NotificationsBellIcon } from "~/components/NotificationsBellIcon.tsx";
import { UnreadNotificationsFaviconBadge } from "~/components/UnreadNotificationsFaviconBadge.tsx";
import {
  type ActingAccountSummary,
  organizationActingAccountKey,
  type OrganizationNotificationBadge as ActingOrganizationNotificationBadge,
  PERSONAL_ACTING_ACCOUNT_KEY,
  useActingAccount,
} from "~/contexts/ActingAccountContext.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import { invalidateNotificationsPageQueryCache } from "~/lib/notificationsPageQueryCache.ts";
import {
  getCurrentSessionId,
  removeSessionCookie,
} from "~/lib/sessionActions.ts";
import {
  invalidateTimelinePageQueryCache,
  TIMELINE_PAGE_QUERY_CACHE_KEYS,
} from "~/lib/timelinePageQueryCache.ts";
import { Trans } from "./Trans.tsx";
import type { AppSidebarSignOutMutation } from "./__generated__/AppSidebarSignOutMutation.graphql.ts";
import type {
  AppSidebar_signedAccount$data,
  AppSidebar_signedAccount$key,
} from "./__generated__/AppSidebar_signedAccount.graphql.ts";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import metadata from "../../package.json" with { type: "json" };

const AppSidebarSignOutMutation = graphql`
  mutation AppSidebarSignOutMutation($sessionId: UUID!) {
    revokeSession(sessionId: $sessionId) {
      id
    }
  }
`;

function setLegacyUiCookie(): void {
  document.cookie = "web-next=false; path=/; max-age=31536000; SameSite=Lax";
}

export interface AppSidebarProps {
  $signedAccount?: AppSidebar_signedAccount$key | null;
  // Keep this separate from $signedAccount. A null account means the viewer
  // query finished and the visitor is anonymous; undefined means it has not
  // resolved yet. The sidebar needs that distinction to show the sign-in link.
  signedAccountLoaded?: boolean;
  personalUnreadNotificationsCount?: number;
}

export function AppSidebar(props: AppSidebarProps) {
  const { t } = useLingui();
  const { open: openNoteCompose } = useNoteCompose();
  const { isMobile, state } = useSidebar();
  const signedAccount = createFragment(
    graphql`
      fragment AppSidebar_signedAccount on Account
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 3 }
        ) {
        name
        id
        username
        avatarUrl
        invitationsLeft
        unreadNotificationsCount
        unreadModerationNotificationCount
        moderator
        pinnedHashtags
        organizationMemberships {
          role
          notificationBadge {
            color
            count
          }
          organization {
            id
            name
            username
            avatarUrl
          }
        }
        articleDrafts(after: $cursor, first: $count)
          @connection(key: "SignedAccount_articleDrafts") {
          __id
          edges {
            node {
              id
              uuid
              title
              updated
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$signedAccount,
  );

  const [signOut] = createMutation<AppSidebarSignOutMutation>(
    AppSidebarSignOutMutation,
  );
  const actingAccount = useActingAccount();

  createEffect(() => {
    const account = signedAccount();
    if (account == null) {
      actingAccount.setAccounts(null, []);
      return;
    }
    actingAccount.setAccounts(
      {
        id: account.id,
        name: account.name,
        username: account.username,
        avatarUrl: account.avatarUrl,
      },
      account.organizationMemberships.map((membership) => ({
        role: membership.role,
        notificationBadge: membership.notificationBadge,
        organization: {
          id: membership.organization.id,
          name: membership.organization.name,
          username: membership.organization.username,
          avatarUrl: membership.organization.avatarUrl,
        },
      })),
    );
  });

  const personalUnreadNotificationsCount = () => {
    const account = signedAccount();
    return props.personalUnreadNotificationsCount ??
      (account == null ? 0 : account.unreadNotificationsCount +
        (account.unreadModerationNotificationCount ?? 0));
  };

  const currentNotificationBadge = ():
    | ActingOrganizationNotificationBadge
    | null => {
    const organization = actingAccount.selectedOrganization();
    if (organization != null) {
      return organization.notificationBadge ?? null;
    }
    const count = personalUnreadNotificationsCount();
    return count > 0 ? { color: "RED", count } : null;
  };

  async function onSignOut() {
    const sessionId = await getCurrentSessionId();
    if (sessionId == null) {
      await removeSessionCookie();
      location.replace("/local");
      return;
    }
    signOut({
      variables: { sessionId },
      onCompleted() {
        void removeSessionCookie().finally(() => location.replace("/local"));
      },
      onError(error) {
        window.alert(
          t`Failed to sign out: ${error.message}`,
        );
        void removeSessionCookie().finally(() => location.replace("/local"));
      },
    });
  }

  return (
    <Sidebar>
      <UnreadNotificationsFaviconBadge
        unread={(currentNotificationBadge()?.count ?? 0) > 0}
      />
      <SidebarHeader>
        <div class="flex items-center justify-between">
          <AppSidebarLogo />
          <Show when={signedAccount()}>
            <HeaderNotifications badge={currentNotificationBadge()} />
          </Show>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>
            {t`Timeline`}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenuItem class="list-none">
              <SidebarMenuButton
                as={A}
                href="/news"
                onClick={() =>
                  invalidateTimelinePageQueryCache(
                    TIMELINE_PAGE_QUERY_CACHE_KEYS.news,
                  )}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-6"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 0 1-2.25 2.25M16.5 7.5V18a2.25 2.25 0 0 0 2.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 0 0 2.25 2.25h13.5M6 7.5h3v3H6v-3Z"
                  />
                </svg>
                {t`News`}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <Show when={signedAccount()}>
              <SidebarMenuItem class="list-none">
                <SidebarMenuButton
                  as={A}
                  href="/feed"
                  onClick={() =>
                    invalidateTimelinePageQueryCache(
                      TIMELINE_PAGE_QUERY_CACHE_KEYS.feed,
                    )}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="1.5"
                    stroke="currentColor"
                    class="size-6"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 0 1 0 3.75H5.625a1.875 1.875 0 0 1 0-3.75Z"
                    />
                  </svg>
                  {t`Feed`}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem class="list-none">
                <SidebarMenuButton
                  as={A}
                  href="/feed/without-shares"
                  onClick={() =>
                    invalidateTimelinePageQueryCache(
                      TIMELINE_PAGE_QUERY_CACHE_KEYS.feedWithoutShares,
                    )}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="1.5"
                    stroke="currentColor"
                    class="size-6"
                  >
                    {
                      /* Share glyph (arrow-path-rounded-square) — same base
                         as the engagement bar's share button — with a
                         diagonal slash from (3, 3) to (21, 21) carved
                         through it, matching the Heroicons `*-slash`
                         family (bell-slash, bolt-slash, bookmark-slash,
                         eye-slash, link-slash, signal-slash,
                         video-camera-slash).  Following bookmark-slash's
                         convention, the entire top-left and bottom-right
                         rounded corner arcs the slash would otherwise
                         cross are omitted from the path — an explicit `M`
                         skips over each corner — and the slash itself is
                         drawn as the path's last segment.  This leaves a
                         generous transparent gutter on each side of the
                         slash without needing a mask, regardless of the
                         menu button's background colour. */
                    }
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0M4.638 8.338c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0M19.362 15.662c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3M3 3l18 18"
                    />
                  </svg>
                  {t`Without shares`}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem class="list-none">
                <SidebarMenuButton
                  as={A}
                  href="/feed/articles"
                  onClick={() =>
                    invalidateTimelinePageQueryCache(
                      TIMELINE_PAGE_QUERY_CACHE_KEYS.feedArticles,
                    )}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="1.5"
                    stroke="currentColor"
                    class="size-6"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                    />
                  </svg>
                  {t`Articles only`}
                </SidebarMenuButton>
              </SidebarMenuItem>
            </Show>
            <SidebarMenuItem class="list-none">
              <SidebarMenuButton
                as={A}
                href="/local"
                onClick={() =>
                  invalidateTimelinePageQueryCache(
                    TIMELINE_PAGE_QUERY_CACHE_KEYS.local,
                  )}
              >
                <img
                  src="/starorbit.svg"
                  alt=""
                  class="size-4 shrink-0 dark:invert"
                />
                {t`Hackers' Pub`}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem class="list-none">
              <SidebarMenuButton
                as={A}
                href="/fediverse"
                onClick={() =>
                  invalidateTimelinePageQueryCache(
                    TIMELINE_PAGE_QUERY_CACHE_KEYS.fediverse,
                  )}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 196.52 196.52"
                  fill="currentColor"
                  class="size-6"
                >
                  <path d="M47.9242 72.7966a18.2278 18.2278 0 0 1-7.7959 7.7597l42.7984 42.9653 10.3182-5.2291zm56.4524 56.6704-10.3182 5.2291 21.686 21.7708a18.2278 18.2278 0 0 1 7.7975-7.7608z" />
                  <path d="M129.6645 102.0765l1.7865 11.4272 27.4149-13.8942a18.2278 18.2278 0 0 1-4.9719-9.8124zm-14.0658 7.1282-57.2891 29.0339a18.2278 18.2278 0 0 1 4.9728 9.8133l54.1027-27.4194z" />
                  <path d="M69.5312 91.6539l8.1618 8.1933 29.269-57.1387a18.2278 18.2278 0 0 1-9.787-5.0219zm-7.1897 14.0363-14.0022 27.3353a18.2278 18.2278 0 0 1 9.786 5.0214l12.3775-24.1639z" />
                  <path d="M39.8906 80.6763a18.2278 18.2278 0 0 1-10.8655 1.7198l8.1762 52.2981a18.2278 18.2278 0 0 1 10.8645-1.7198z" />
                  <path d="M63.3259 148.3109a18.2278 18.2278 0 0 1-1.7322 10.8629l52.2893 8.3907a18.2278 18.2278 0 0 1 1.7322-10.8629z" />
                  <path d="M134.9148 146.9182a18.2278 18.2278 0 0 1 9.788 5.0224l24.1345-47.117a18.2278 18.2278 0 0 1-9.7875-5.0229z" />
                  <path d="M126.1329 33.1603a18.2278 18.2278 0 0 1-7.7975 7.7608l37.3765 37.5207a18.2278 18.2278 0 0 1 7.7969-7.7608z" />
                  <path d="M44.7704 51.6279a18.2278 18.2278 0 0 1 4.9723 9.8123l47.2478-23.9453a18.2278 18.2278 0 0 1-4.9718-9.8113z" />
                  <path d="M118.2491 40.9645a18.2278 18.2278 0 0 1-10.8511 1.8123l4.1853 26.8 11.42 1.8324zm-4.2333 44.1927 9.8955 63.3631a18.2278 18.2278 0 0 1 10.88-1.6278l-9.355-59.9035z" />
                  <path d="M49.7763 61.6412a18.2278 18.2278 0 0 1-1.694 10.8686l26.8206 4.3077 5.2715-10.2945zm45.9677 7.382-5.272 10.2955 63.3713 10.1777a18.2278 18.2278 0 0 1 1.7606-10.8593z" />
                  <path d="M93.4385 23.8419a1 1 0 1 0 33.0924 1.8025 1 1 0 1 0-33.0924-1.8025" />
                  <path d="M155.314 85.957a1 1 0 1 0 33.0923 1.8025 1 1 0 1 0-33.0923-1.8025" />
                  <path d="M115.3466 163.9824a1 1 0 1 0 33.0923 1.8025 1 1 0 1 0-33.0923-1.8025" />
                  <path d="M28.7698 150.0898a1 1 0 1 0 33.0923 1.8025 1 1 0 1 0-33.0923-1.8025" />
                  <path d="M15.2298 63.4781a1 1 0 1 0 33.0923 1.8025 1 1 0 1 0-33.0923-1.8025" />
                </svg>
                {t`Fediverse`}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem class="list-none">
              <SidebarMenuButton
                as={A}
                href="/search"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-6"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"
                  />
                </svg>
                {t`Search`}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <For each={signedAccount()?.pinnedHashtags ?? []}>
              {(tag) => (
                <SidebarMenuItem class="list-none">
                  <SidebarMenuButton
                    as={A}
                    href={`/tags/${encodeURIComponent(tag)}`}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke-width="1.5"
                      stroke="currentColor"
                      class="size-6"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M5.25 8.25h15m-16.5 7.5h15m-1.8-13.5-3.9 19.5m-2.1-19.5-3.9 19.5"
                      />
                    </svg>
                    #{tag}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </For>
          </SidebarGroupContent>
        </SidebarGroup>
        <ComposeSection
          signedAccount={signedAccount()}
          visible={!!signedAccount() &&
            !isMobile() && state() !== "collapsed"}
          onComposeNote={openNoteCompose}
        />
        <RecentDraftsSection
          signedAccount={signedAccount()}
          visible={!!signedAccount() &&
            !isMobile() && state() !== "collapsed"}
        />
        <AccountSection
          signedAccount={signedAccount()}
          signedAccountLoaded={props.signedAccountLoaded}
          onSignOut={onSignOut}
        />
      </SidebarContent>
      <AppSidebarFooter />
    </Sidebar>
  );
}

function AppSidebarLogo() {
  const { t } = useLingui();

  return (
    <h1 class="font-bold m-2">
      <A href="/">
        <picture>
          <source
            srcset="/logo-dark.svg"
            media="(prefers-color-scheme: dark)"
          />
          <img
            src="/logo-light.svg"
            alt={t`Hackers' Pub`}
            width={139}
            height={35}
            class="w-[139px] h-[35px]"
          />
        </picture>
      </A>
    </h1>
  );
}

interface ActingAccountMenuOption {
  key: string;
  account: ActingAccountSummary;
  badge?: ActingOrganizationNotificationBadge | null;
}

function ActingAccountMenu() {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const options = createMemo<ActingAccountMenuOption[]>(() => {
    const personalAccount = actingAccount.personalAccount();
    if (personalAccount == null) return [];
    return [
      {
        key: PERSONAL_ACTING_ACCOUNT_KEY,
        account: personalAccount,
      },
      ...actingAccount.organizations().map((membership) => ({
        key: organizationActingAccountKey(membership.organization.id),
        account: membership.organization,
        badge: membership.notificationBadge,
      })),
    ];
  });
  const selectedOption = () =>
    options().find((option) => option.key === actingAccount.selectedKey()) ??
      options()[0];

  return (
    <Show
      when={options().length > 1 && selectedOption() != null}
    >
      <div class="-mx-2 -mb-2 border-t border-sidebar-border group-data-[collapsible=icon]:mx-0 group-data-[collapsible=icon]:mb-0 group-data-[collapsible=icon]:border-t-0">
        <DropdownMenu modal={false} placement="top-start" gutter={6}>
          <DropdownMenuTrigger
            class="flex min-h-14 w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 data-[expanded]:bg-sidebar-accent data-[expanded]:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:min-h-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
            aria-label={`${t`Act as`}: ${
              accountDisplayName(selectedOption()!.account)
            }`}
          >
            <ActingAccountMenuTrigger option={selectedOption()!} />
            <IconChevronsUpDown
              class="ml-auto size-4 shrink-0 opacity-50 group-data-[collapsible=icon]:hidden"
              aria-hidden="true"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="w-60 max-w-[calc(100vw-1rem)]">
            <DropdownMenuRadioGroup<string>
              value={actingAccount.selectedKey()}
              onChange={(key) => actingAccount.setSelectedKey(key)}
            >
              <DropdownMenuGroup>
                <DropdownMenuGroupLabel class="sr-only">
                  {t`Act as`}
                </DropdownMenuGroupLabel>
                <For each={options()}>
                  {(option) => (
                    <DropdownMenuRadioItem
                      value={option.key}
                      indicator={<IconCheck class="size-4" />}
                      indicatorPlacement="right"
                      class="gap-2"
                    >
                      <ActingAccountMenuOptionRow option={option} />
                    </DropdownMenuRadioItem>
                  )}
                </For>
              </DropdownMenuGroup>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Show>
  );
}

function ActingAccountMenuTrigger(props: { option: ActingAccountMenuOption }) {
  return (
    <>
      <AccountAvatar account={props.option.account} class="size-7" />
      <span class="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
        <span class="block truncate font-medium leading-5">
          {accountDisplayName(props.option.account)}
        </span>
        <span class="block truncate text-xs text-sidebar-foreground/65">
          {accountHandle(props.option.account)}
        </span>
      </span>
      <span class="group-data-[collapsible=icon]:hidden">
        <OrganizationNotificationBadge badge={props.option.badge} />
      </span>
    </>
  );
}

function ActingAccountMenuOptionRow(props: {
  option: ActingAccountMenuOption;
}) {
  return (
    <span class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden py-0.5">
      <AccountAvatar account={props.option.account} class="size-6" />
      <span class="min-w-0 flex-1">
        <span class="block truncate">
          {accountDisplayName(props.option.account)}
        </span>
        <span class="block truncate text-xs text-muted-foreground">
          {accountHandle(props.option.account)}
        </span>
      </span>
      <OrganizationNotificationBadge badge={props.option.badge} />
    </span>
  );
}

function AccountAvatar(props: {
  account: ActingAccountSummary;
  class?: string;
}) {
  return (
    <Avatar class={props.class} aria-hidden="true">
      <AvatarImage src={props.account.avatarUrl ?? undefined} />
      <AvatarFallback class="text-[0.625rem]">
        {accountInitial(props.account)}
      </AvatarFallback>
    </Avatar>
  );
}

function OrganizationNotificationBadge(props: {
  badge?: ActingOrganizationNotificationBadge | null;
}) {
  const badge = () => props.badge;

  return (
    <Show when={badge() != null && badge()!.count > 0}>
      <span
        aria-hidden="true"
        class="ml-auto flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold leading-none"
        classList={{
          "bg-red-500 text-white": badge()!.color === "RED",
          "bg-muted-foreground/25 text-sidebar-foreground":
            badge()!.color !== "RED",
        }}
      >
        {badge()!.count > 99 ? "99+" : badge()!.count}
      </span>
    </Show>
  );
}

function accountDisplayName(account: ActingAccountSummary): string {
  return account.name || account.username;
}

function accountHandle(account: ActingAccountSummary): string {
  return `@${account.username}`;
}

function accountInitial(account: ActingAccountSummary): string {
  return accountDisplayName(account).charAt(0).toUpperCase();
}

interface HeaderNotificationsProps {
  badge?: ActingOrganizationNotificationBadge | null;
}

function HeaderNotifications(props: HeaderNotificationsProps) {
  const { t, i18n } = useLingui();
  const count = () => props.badge?.count ?? 0;

  return (
    <Button
      as={A}
      href="/notifications"
      onClick={invalidateNotificationsPageQueryCache}
      variant="ghost"
      size="icon"
      class="relative size-9 shrink-0 rounded-full"
      aria-label={count() > 0
        ? i18n._(
          msg`${
            plural(count(), {
              one: "Notifications (# unread)",
              other: "Notifications (# unread)",
            })
          }`,
        )
        : t`Notifications`}
      title={t`Notifications`}
    >
      <NotificationsBellIcon class="size-5" />
      <Show when={count() > 0}>
        <span
          aria-hidden="true"
          class="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold leading-none ring-2 ring-sidebar"
          classList={{
            "bg-red-500 text-white": props.badge?.color === "RED",
            "bg-muted-foreground/25 text-sidebar-foreground":
              props.badge?.color !== "RED",
          }}
        >
          {count() > 99 ? "99+" : count()}
        </span>
      </Show>
    </Button>
  );
}

interface AccountSectionProps {
  signedAccount?: AppSidebar_signedAccount$data | null;
  signedAccountLoaded?: boolean;
  onSignOut: () => void;
}

function AccountSection(props: AccountSectionProps) {
  const { t } = useLingui();
  const location = useLocation();
  const actingAccount = useActingAccount();
  const profileAccount = () =>
    actingAccount.selectedOrganization()?.organization ??
      actingAccount.personalAccount() ??
      props.signedAccount;

  function onUseOldUI() {
    setLegacyUiCookie();
    window.location.reload();
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        {t`Account`}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenuItem class="list-none">
          <SidebarMenuButton on:click={onUseOldUI} class="cursor-pointer">
            <IconUndo2 class="size-6" />
            {t`Use old UI`}
          </SidebarMenuButton>
        </SidebarMenuItem>
        <Show
          when={!props.signedAccountLoaded}
        >
          <AccountSectionPlaceholder />
        </Show>
        <Show
          keyed
          when={props.signedAccountLoaded && !props.signedAccount}
        >
          {(_) => (
            <SidebarMenuItem class="list-none">
              <SidebarMenuButton
                as={A}
                href={`/sign?next=${
                  encodeURIComponent(
                    location.pathname + location.search + location.hash,
                  )
                }`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-6"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z"
                  />
                </svg>
                {t`Sign in`}
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </Show>
        <Show
          keyed
          when={props.signedAccountLoaded && props.signedAccount}
        >
          {(signedAccount) => (
            <>
              <SidebarMenuItem class="list-none">
                <SidebarMenuButton
                  as={A}
                  href={`/@${
                    profileAccount()?.username ?? signedAccount.username
                  }`}
                >
                  <AccountAvatar
                    account={profileAccount() ?? signedAccount}
                    class="size-4"
                  />
                  <span class="min-w-0 truncate">
                    {accountDisplayName(profileAccount() ?? signedAccount)}
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem class="list-none">
                <SidebarMenuButton
                  as={A}
                  href={`/@${signedAccount.username}/bookmarks`}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="1.5"
                    stroke="currentColor"
                    class="size-6"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z"
                    />
                  </svg>
                  {t`Bookmarks`}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <Show when={signedAccount.invitationsLeft > 0}>
                <SidebarMenuItem class="list-none">
                  <SidebarMenuButton
                    as={A}
                    href={`/@${signedAccount.username}/settings/invite`}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke-width="1.5"
                      stroke="currentColor"
                      class="size-6"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75"
                      />
                    </svg>
                    {t`Invite`}
                    <span class="text-xs text-muted-foreground">
                      ({signedAccount.invitationsLeft})
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </Show>
              <SidebarMenuItem class="list-none">
                <SidebarMenuButton
                  as={A}
                  href={`/@${signedAccount.username}/settings`}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke-width="1.5"
                    stroke="currentColor"
                    class="size-6"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 0 1 1.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.559.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.894.149c-.424.07-.764.383-.929.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 0 1-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.398.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 0 1-.12-1.45l.527-.737c.25-.35.272-.806.108-1.204-.165-.397-.506-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 0 1 .12-1.45l.773-.773a1.125 1.125 0 0 1 1.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894Z"
                    />
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
                    />
                  </svg>
                  {t`Settings`}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <Show when={signedAccount.moderator}>
                <SidebarMenuItem class="list-none">
                  <SidebarMenuButton
                    as={A}
                    href="/admin"
                  >
                    <IconShieldCheck class="size-6" />
                    {t`Admin`}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </Show>
              <SignOutMenuItem onSignOut={props.onSignOut} />
            </>
          )}
        </Show>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function AccountSectionPlaceholder() {
  return (
    <>
      <AccountSectionPlaceholderItem widthClass="w-28" />
      <AccountSectionPlaceholderItem widthClass="w-24" />
      <AccountSectionPlaceholderItem widthClass="w-20" />
      <AccountSectionPlaceholderItem widthClass="w-16" />
    </>
  );
}

interface AccountSectionPlaceholderItemProps {
  widthClass: string;
}

function AccountSectionPlaceholderItem(
  props: AccountSectionPlaceholderItemProps,
) {
  return (
    <SidebarMenuItem class="list-none">
      <div
        aria-hidden="true"
        class="flex h-8 items-center gap-2 rounded-md px-2"
      >
        <span class="size-4 shrink-0 rounded bg-sidebar-foreground/10" />
        <span
          class={`h-4 rounded bg-sidebar-foreground/10 ${props.widthClass}`}
        />
      </div>
    </SidebarMenuItem>
  );
}

interface ComposeSectionProps {
  signedAccount?: AppSidebar_signedAccount$data | null;
  visible?: boolean;
  onComposeNote: () => void;
}

function ComposeSection(props: ComposeSectionProps) {
  const { t } = useLingui();

  return (
    <Show keyed when={props.visible && props.signedAccount}>
      {(signedAccount) => (
        <SidebarGroup>
          <SidebarGroupLabel>
            {t`Compose`}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenuItem class="list-none">
              <SidebarMenuButton
                onClick={props.onComposeNote}
                class="cursor-pointer"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-6"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10"
                  />
                </svg>
                {t`Create note`}
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem class="list-none">
              <SidebarMenuButton
                as={A}
                href={`/@${signedAccount.username}/drafts/new`}
                class="cursor-pointer"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-6"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                  />
                </svg>
                {t`Create article`}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarGroupContent>
        </SidebarGroup>
      )}
    </Show>
  );
}

interface RecentDraftsSectionProps {
  signedAccount?: AppSidebar_signedAccount$data | null;
  visible?: boolean;
}

function RecentDraftsSection(props: RecentDraftsSectionProps) {
  const { t } = useLingui();
  const visibleDrafts = () =>
    props.signedAccount?.articleDrafts?.edges.filter((edge) =>
      edge.node != null
    ).slice(0, 3) ?? [];
  const hasMoreDrafts = () => {
    const articleDrafts = props.signedAccount?.articleDrafts;
    if (articleDrafts == null) return false;
    const edgesCount = articleDrafts.edges.filter((edge) => edge.node != null)
      .length;
    return articleDrafts.pageInfo?.hasNextPage || edgesCount > 3;
  };

  return (
    <Show
      when={props.visible && props.signedAccount != null &&
        visibleDrafts().length > 0}
    >
      <SidebarGroup>
        <SidebarGroupLabel>
          {t`Recent drafts`}
        </SidebarGroupLabel>
        <SidebarGroupContent>
          <For each={visibleDrafts()}>
            {(edge) => (
              <SidebarMenuItem class="list-none">
                <SidebarMenuButton
                  as={A}
                  href={`/@${
                    props.signedAccount!.username
                  }/drafts/${edge.node.uuid}`}
                >
                  {edge.node.title}
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
          </For>
          <Show when={hasMoreDrafts()}>
            <SidebarMenuItem class="list-none">
              <SidebarMenuButton
                as={A}
                href={`/@${props.signedAccount!.username}/drafts`}
                class="text-muted-foreground"
              >
                {t`View all drafts →`}
              </SidebarMenuButton>
            </SidebarMenuItem>
          </Show>
        </SidebarGroupContent>
      </SidebarGroup>
    </Show>
  );
}

interface SignOutMenuItemProps {
  onSignOut: () => void;
}

function SignOutMenuItem(props: SignOutMenuItemProps) {
  const { t } = useLingui();

  return (
    <SidebarMenuItem class="list-none">
      <SidebarMenuButton
        on:click={props.onSignOut}
        class="cursor-pointer"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.5"
          stroke="currentColor"
          class="size-6"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M8.25 9V5.25A2.25 2.25 0 0 1 10.5 3h6a2.25 2.25 0 0 1 2.25 2.25v13.5A2.25 2.25 0 0 1 16.5 21h-6a2.25 2.25 0 0 1-2.25-2.25V15m-3 0-3-3m0 0 3-3m-3 3H15"
          />
        </svg>
        {t`Sign out`}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function AppSidebarFooter() {
  const { t } = useLingui();

  return (
    <SidebarFooter>
      <div class="group-data-[collapsible=icon]:hidden">
        <p class="m-2 mb-0 text-sm">
          <A href="/tree" class="underline">
            {t`Invitation tree`}
          </A>
        </p>
        <p class="m-2 mb-0 text-sm">
          <A
            href="/coc"
            class="underline"
          >
            {t`Code of conduct`}
          </A>{" "}
          &middot;{" "}
          <A
            href="/privacy"
            class="underline"
          >
            {t`Privacy policy`}
          </A>
        </p>
        <p class="m-2 mb-0 text-sm">
          <a
            href="https://play.google.com/store/apps/details?id=pub.hackers.android"
            target="_blank"
            rel="noopener noreferrer"
            class="underline"
          >
            Android
          </a>{" "}
          &middot;{" "}
          <a
            href="https://testflight.apple.com/join/wEBBtbzA"
            target="_blank"
            rel="noopener noreferrer"
            class="underline"
          >
            iOS/iPadOS
          </a>
        </p>
        <p class="m-2 text-sm">
          <Trans
            message={t`The source code of this website is available on ${"GITHUB_REPOSITORY"} under the ${"AGPL-3.0"} license.`}
            values={{
              GITHUB_REPOSITORY: () => (
                <a
                  href="https://github.com/hackers-pub/hackerspub"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline"
                >
                  {t`GitHub repository`}
                </a>
              ),
              "AGPL-3.0": () => (
                <a
                  href="https://www.gnu.org/licenses/agpl-3.0.en.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="underline"
                >
                  AGPL 3.0
                </a>
              ),
            }}
          />{" "}
          v{metadata.version.split("+")[0]}
          {metadata.version.includes("+") && (
            <>
              +
              <a
                href={`https://github.com/hackers-pub/hackerspub/commit/${
                  metadata.version.split("+")[1]
                }`}
                target="_blank"
                rel="noopener noreferrer"
                class="underline"
              >
                {metadata.version.split("+")[1].slice(0, 8)}
              </a>
            </>
          )}
        </p>
      </div>
      <ActingAccountMenu />
    </SidebarFooter>
  );
}
