import { type Uuid, validateUuid } from "@hackerspub/models/uuid";
import { A, useLocation } from "@solidjs/router";
import {
  deleteCookie,
  getCookie,
  getRequestProtocol,
} from "@solidjs/start/http";
import { fetchQuery, graphql, type Subscription } from "relay-runtime";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { getRequestEvent } from "solid-js/web";
import {
  createFragment,
  createMutation,
  useRelayEnvironment,
} from "solid-relay";
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
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { Trans } from "./Trans.tsx";
import type { AppSidebarSignOutMutation } from "./__generated__/AppSidebarSignOutMutation.graphql.ts";
import type { AppSidebarUnreadNotificationsQuery } from "./__generated__/AppSidebarUnreadNotificationsQuery.graphql.ts";
import type {
  AppSidebar_signedAccount$data,
  AppSidebar_signedAccount$key,
} from "./__generated__/AppSidebar_signedAccount.graphql.ts";
import { Avatar, AvatarImage } from "./ui/avatar.tsx";
import metadata from "../../package.json" with { type: "json" };

const sidebarNavigationLinkProps = {
  // Solid Router preloads internal links on hover by default. In the sidebar,
  // that makes ordinary menu scanning start route/data loads, which can briefly
  // trip the root Suspense fallback and flash the page white.
  preload: false,
} as const;

const AppSidebarSignOutMutation = graphql`
  mutation AppSidebarSignOutMutation($sessionId: UUID!) {
    revokeSession(sessionId: $sessionId) {
      id
    }
  }
`;

const AppSidebarUnreadNotificationsQuery = graphql`
  query AppSidebarUnreadNotificationsQuery {
    viewer {
      unreadNotificationsCount
    }
  }
`;

async function removeSessionCookie(): Promise<Uuid | null> {
  "use server";
  const event = getRequestEvent();
  if (event != null) {
    const sessionId = getCookie(event.nativeEvent, "session");
    deleteCookie(event.nativeEvent, "session", {
      httpOnly: true,
      path: "/",
      secure: getRequestProtocol(event.nativeEvent) === "https",
    });
    if (sessionId != null && validateUuid(sessionId)) {
      return sessionId;
    }
  }
  return null;
}

function removeWebNextCookie(): void {
  document.cookie = "web-next=; max-age=0; path=/; SameSite=Lax";
}

export interface AppSidebarProps {
  $signedAccount?: AppSidebar_signedAccount$key | null;
  // Keep this separate from $signedAccount. A null account means the viewer
  // query finished and the visitor is anonymous; undefined means it has not
  // resolved yet. The sidebar needs that distinction to show the sign-in link.
  signedAccountLoaded?: boolean;
}

export function AppSidebar(props: AppSidebarProps) {
  const { t } = useLingui();
  const { open: openNoteCompose } = useNoteCompose();
  const { isMobile, state } = useSidebar();
  const environment = useRelayEnvironment();
  const [unreadNotificationsCount, setUnreadNotificationsCount] = createSignal<
    number
  >();
  const [documentVisible, setDocumentVisible] = createSignal(true);
  const signedAccount = createFragment(
    graphql`
      fragment AppSidebar_signedAccount on Account
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 3 }
        ) {
        name
        username
        avatarUrl
        invitationsLeft
        unreadNotificationsCount
        moderator
        pinnedHashtags
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

  createEffect(() => {
    setUnreadNotificationsCount(signedAccount.latest?.unreadNotificationsCount);
  });

  onMount(() => {
    const onVisibilityChange = () => {
      setDocumentVisible(document.visibilityState === "visible");
    };
    onVisibilityChange();
    document.addEventListener("visibilitychange", onVisibilityChange);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    });
  });

  createEffect(() => {
    if (signedAccount.latest?.username == null || !documentVisible()) {
      return;
    }

    let pending: Subscription | null = null;
    const poll = () => {
      if (pending != null) return;
      pending = fetchQuery<AppSidebarUnreadNotificationsQuery>(
        environment(),
        AppSidebarUnreadNotificationsQuery,
        {},
      ).subscribe({
        next(data) {
          setUnreadNotificationsCount(
            data.viewer?.unreadNotificationsCount ?? undefined,
          );
        },
        complete() {
          pending = null;
        },
        error(error: unknown) {
          pending = null;
          console.error("Notification count polling failed:", error);
        },
      });
    };

    const interval = setInterval(poll, 10_000);
    onCleanup(() => {
      clearInterval(interval);
      pending?.unsubscribe();
    });
  });

  const [signOut] = createMutation<AppSidebarSignOutMutation>(
    AppSidebarSignOutMutation,
  );

  async function onSignOut() {
    const sessionId = await removeSessionCookie();
    if (sessionId != null) {
      signOut({
        variables: { sessionId },
        onCompleted() {
          location.replace("/local");
        },
        onError(error) {
          window.alert(
            t`Failed to sign out: ${error.message}`,
          );
        },
      });
    }
  }

  return (
    <Sidebar>
      <SidebarHeader>
        <AppSidebarLogo />
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
                {...sidebarNavigationLinkProps}
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
                  {...sidebarNavigationLinkProps}
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
                  {...sidebarNavigationLinkProps}
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
                  {...sidebarNavigationLinkProps}
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
                {...sidebarNavigationLinkProps}
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
                {...sidebarNavigationLinkProps}
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
                {...sidebarNavigationLinkProps}
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
                    {...sidebarNavigationLinkProps}
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
          unreadNotificationsCount={unreadNotificationsCount()}
          onSignOut={onSignOut}
        />
        <AdminSection signedAccount={signedAccount()} />
      </SidebarContent>
      <AppSidebarFooter />
    </Sidebar>
  );
}

function AppSidebarLogo() {
  const { t } = useLingui();

  return (
    <h1 class="font-bold m-2">
      <A href="/" {...sidebarNavigationLinkProps}>
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

interface AccountSectionProps {
  signedAccount?: AppSidebar_signedAccount$data | null;
  signedAccountLoaded?: boolean;
  unreadNotificationsCount?: number;
  onSignOut: () => void;
}

function AccountSection(props: AccountSectionProps) {
  const { t } = useLingui();
  const location = useLocation();
  const unreadNotificationsCount = () =>
    props.unreadNotificationsCount ??
      props.signedAccount?.unreadNotificationsCount ?? 0;

  function onReturnToOldUI() {
    removeWebNextCookie();
    window.location.reload();
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>
        {t`Account`}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenuItem class="list-none">
          <SidebarMenuButton on:click={onReturnToOldUI} class="cursor-pointer">
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
                d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18"
              />
            </svg>
            {t`Return to old UI`}
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
                {...sidebarNavigationLinkProps}
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
                  href={`/notifications`}
                  {...sidebarNavigationLinkProps}
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
                      d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z"
                    />
                    <Show when={unreadNotificationsCount() > 0}>
                      <circle
                        class="fill-red-500 stroke-background stroke-2"
                        cx="19"
                        cy="19"
                        r="3.5"
                      />
                    </Show>
                  </svg>
                  {t`Notifications`}
                  <Show when={unreadNotificationsCount() > 0}>
                    <span class="text-xs text-muted-foreground">
                      ({unreadNotificationsCount()})
                    </span>
                  </Show>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem class="list-none">
                <SidebarMenuButton
                  as={A}
                  href={`/@${signedAccount.username}`}
                  {...sidebarNavigationLinkProps}
                >
                  <Avatar class="size-4">
                    <AvatarImage
                      src={signedAccount.avatarUrl}
                      width={16}
                      height={16}
                    />
                  </Avatar>
                  {signedAccount.name}
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem class="list-none">
                <SidebarMenuButton
                  as={A}
                  href={`/@${signedAccount.username}/bookmarks`}
                  {...sidebarNavigationLinkProps}
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
                    {...sidebarNavigationLinkProps}
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
                  {...sidebarNavigationLinkProps}
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

interface AdminSectionProps {
  signedAccount?: AppSidebar_signedAccount$data | null;
}

function AdminSection(props: AdminSectionProps) {
  const { t } = useLingui();
  return (
    <Show when={props.signedAccount?.moderator}>
      <SidebarGroup>
        <SidebarGroupLabel>{t`Admin`}</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenuItem class="list-none">
            <SidebarMenuButton
              as={A}
              href="/admin"
              {...sidebarNavigationLinkProps}
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
                  d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z"
                />
              </svg>
              {t`Accounts`}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem class="list-none">
            <SidebarMenuButton
              as={A}
              href="/admin/invitations"
              {...sidebarNavigationLinkProps}
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
                  d="M21.75 9v.906a2.25 2.25 0 0 1-1.183 1.981l-6.478 3.488M2.25 9v.906a2.25 2.25 0 0 0 1.183 1.981l6.478 3.488m8.839 2.51-4.66-2.51m0 0-1.023-.55a2.25 2.25 0 0 0-2.134 0l-1.022.55m0 0-4.661 2.51m16.5 1.615a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V8.844a2.25 2.25 0 0 1 1.183-1.981l7.5-4.039a2.25 2.25 0 0 1 2.134 0l7.5 4.039a2.25 2.25 0 0 1 1.183 1.98V19.5Z"
                />
              </svg>
              {t`Invitations`}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem class="list-none">
            <SidebarMenuButton
              as={A}
              href="/admin/media"
              {...sidebarNavigationLinkProps}
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
                  d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Z"
                />
              </svg>
              {t`Media`}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem class="list-none">
            <SidebarMenuButton
              as={A}
              href="/admin/news"
              {...sidebarNavigationLinkProps}
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
                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
                />
              </svg>
              {t`News scores`}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarGroupContent>
      </SidebarGroup>
    </Show>
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
                {...sidebarNavigationLinkProps}
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
                  {...sidebarNavigationLinkProps}
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
                {...sidebarNavigationLinkProps}
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
      <p class="m-2 mb-0 text-sm underline">
        <A href="/coc" {...sidebarNavigationLinkProps}>
          {t`Code of conduct`}
        </A>
      </p>
      <p class="m-2 mb-0 text-sm underline">
        <A href="/privacy" {...sidebarNavigationLinkProps}>
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
    </SidebarFooter>
  );
}
