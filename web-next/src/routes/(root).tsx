import {
  A,
  type RouteDefinition,
  type RouteSectionProps,
  useLocation,
} from "@solidjs/router";
import * as Sentry from "@sentry/solidstart";
import {
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  onMount,
  Show,
  Suspense,
} from "solid-js";
import { graphql } from "relay-runtime";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { AppSidebar } from "~/components/AppSidebar.tsx";
import { NotificationsBellIcon } from "~/components/NotificationsBellIcon.tsx";
import { Button } from "~/components/ui/button.tsx";
import { FloatingComposeButton } from "~/components/FloatingComposeButton.tsx";
import { NoteComposeModal } from "~/components/NoteComposeModal.tsx";
import { SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar.tsx";
import { Toaster } from "~/components/ui/toast.tsx";
import { WebPushPromptBanner } from "~/components/WebPushPromptBanner.tsx";
import {
  ActingAccountProvider,
  type OrganizationNotificationBadge,
  useActingAccount,
} from "~/contexts/ActingAccountContext.tsx";
import { NoteComposeProvider } from "~/contexts/NoteComposeContext.tsx";
import { ViewerProvider } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { invalidateNotificationsPageQueryCache } from "~/lib/notificationsPageQueryCache.ts";
import { createUnreadNotificationsCount } from "~/lib/unreadNotificationsCount.ts";
import type { RootLayoutQuery } from "./__generated__/RootLayoutQuery.graphql.ts";
import { preloadRouteQuery, routePreloadedQuery } from "~/lib/relayPreload.ts";

export const route = {
  preload(args) {
    // The root layout query is `network-only` and backs the currently mounted
    // app chrome. Hover preloads should not refresh that live root resource.
    if (args.intent === "preload") return;
    preloadRouteQuery(args, loadRootLayoutQuery);
  },
} satisfies RouteDefinition;

const RootLayoutQuery = graphql`
  query RootLayoutQuery {
    webPushVapidPublicKey
    viewer {
      uuid
      username
      moderator
      preferAiSummary
      unreadNotificationsCount
      unreadModerationNotificationCount
      organizationMemberships {
        notificationBadge {
          count
        }
      }
      actor {
        suspended
      }
      ...AppSidebar_signedAccount
      ...FloatingComposeButton_signedAccount
    }
  }
`;

const loadRootLayoutQuery = routePreloadedQuery(
  () =>
    loadQuery<RootLayoutQuery>(
      useRelayEnvironment()(),
      RootLayoutQuery,
      {},
      { fetchPolicy: "network-only" },
    ),
  "loadRootLayoutQuery",
);

function RouteLoadingFallback() {
  return (
    <div
      class="mx-auto w-full max-w-160 px-4 py-4 sm:py-6"
      aria-hidden="true"
    >
      <div class="space-y-4">
        <div class="h-8 w-48 rounded-md bg-muted animate-pulse" />
        <div class="overflow-hidden rounded-lg border bg-card shadow-sm">
          <For each={[0, 1, 2]}>
            {() => (
              <div class="border-b p-4 last:border-b-0">
                <div class="flex gap-3">
                  <div class="size-10 shrink-0 rounded-full bg-muted animate-pulse" />
                  <div class="min-w-0 flex-1 space-y-3">
                    <div class="flex items-center gap-2">
                      <div class="h-4 w-28 rounded bg-muted animate-pulse" />
                      <div class="h-3 w-20 rounded bg-muted animate-pulse" />
                    </div>
                    <div class="space-y-2">
                      <div class="h-4 w-full rounded bg-muted animate-pulse" />
                      <div class="h-4 w-5/6 rounded bg-muted animate-pulse" />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export default function RootLayout(props: RouteSectionProps) {
  const { i18n, t } = useLingui();
  const location = useLocation();
  const signedAccount = createPreloadedQuery<RootLayoutQuery>(
    RootLayoutQuery,
    () => loadRootLayoutQuery(),
  );
  const [chromeMounted, setChromeMounted] = createSignal(false);
  onMount(() => setChromeMounted(true));
  // Root chrome contains several auth-dependent branches in the sidebar and
  // floating compose button. Keep those branches out of the SSR/hydration pass:
  // SolidStart can hydrate route query resources in a slightly different order
  // from the streamed HTML, and a logged-in sidebar shape mismatch aborts the
  // whole page. Child routes still receive the real viewer state below.
  const chromeSignedAccountLoaded = () =>
    chromeMounted() && !signedAccount.pending;
  const chromeSignedAccount = () =>
    chromeMounted() ? signedAccount()?.viewer : undefined;
  const personalUnreadNotificationsCount = createUnreadNotificationsCount(
    chromeSignedAccount,
  );
  const showFloatingCompose = () => {
    if (!chromeSignedAccountLoaded() || !chromeSignedAccount()) return false;
    return !/^\/(?:@[^/]+\/(?:drafts|settings)|sign)(?:\/|$)/.test(
      location.pathname,
    );
  };
  // The article writing surfaces (draft composer and the published-article
  // editor) render full-bleed, so hide the sidebar and mobile header on those
  // routes. Matches `/@handle/drafts/new`, `/@handle/drafts/{uuid}`, and
  // `/@handle/{year|id}/{slug}/edit` (but not the bare `/@handle/drafts` list).
  const isComposeRoute = createMemo(() =>
    /^\/@[^/]+\/drafts\/[^/]+/.test(location.pathname) ||
    /^\/@[^/]+\/[^/]+\/[^/]+\/edit\/?$/.test(location.pathname)
  );
  // Tag every Sentry event with the signed-in viewer so errors carry user
  // identity — this covers both browser-side captures (errors from
  // app.tsx's ErrorBoundary, RelayEnvironment.tsx's network-failure
  // captures, the Vite stale-chunk handler in entry-client.tsx) and the
  // SSR side, where `@sentry/solidstart` uses `@sentry/node`'s
  // `httpIntegration` to fork an isolation scope per request and
  // `Sentry.setUser` routes to that scope.
  //
  // `createRenderEffect` is used (not `createEffect`) because plain
  // `createEffect` is a no-op on the server build of solid-js, which
  // would leave SSR-rendered errors un-tagged. Render effects run on
  // both server and client and re-fire whenever `signedAccount`
  // resolves or changes — including a `setUser(null)` on sign-out so a
  // previous session's identity doesn't bleed onto subsequent
  // anonymous events.
  createRenderEffect(() => {
    if (signedAccount.pending) return;
    const viewer = signedAccount()?.viewer;
    if (viewer == null) {
      Sentry.setUser(null);
      return;
    }
    Sentry.setUser({
      id: viewer.uuid,
      username: viewer.username,
    });
  });
  return (
    <ViewerProvider
      isAuthenticated={() =>
        !signedAccount.pending && !!signedAccount()?.viewer}
      isLoaded={() => !signedAccount.pending}
      username={() => signedAccount()?.viewer?.username}
      moderator={() => signedAccount()?.viewer?.moderator ?? false}
      suspended={() => signedAccount()?.viewer?.actor?.suspended ?? false}
      preferAiSummary={() => signedAccount()?.viewer?.preferAiSummary ?? true}
    >
      <ActingAccountProvider>
        <NoteComposeProvider>
          <SidebarProvider>
            <Show when={!isComposeRoute()}>
              <AppSidebar
                $signedAccount={chromeSignedAccount()}
                signedAccountLoaded={chromeSignedAccountLoaded()}
                personalUnreadNotificationsCount={personalUnreadNotificationsCount()}
              />
              <header class="fixed inset-x-0 top-0 z-40 border-b bg-background/80 backdrop-blur md:hidden">
                <div class="flex h-14 items-center justify-between px-4">
                  <SidebarTrigger
                    class="size-9 rounded-full"
                    aria-label={t`Toggle sidebar`}
                  />
                  <A href="/" aria-label={t`Hackers' Pub home`}>
                    <picture>
                      <source
                        srcset="/logo-dark.svg"
                        media="(prefers-color-scheme: dark)"
                      />
                      <img
                        src="/logo-light.svg"
                        alt={t`Hackers' Pub`}
                        width={111}
                        height={28}
                        class="h-7 w-auto"
                      />
                    </picture>
                  </A>
                  <Show
                    when={chromeSignedAccount()}
                    fallback={<div class="size-9" aria-hidden="true" />}
                  >
                    <MobileHeaderNotifications
                      personalUnreadNotificationsCount={personalUnreadNotificationsCount()}
                    />
                  </Show>
                </div>
              </header>
            </Show>
            <main
              lang={new Intl.Locale(i18n.locale).minimize().baseName}
              class="w-full"
              classList={{
                "pt-14 md:pt-0": !isComposeRoute(),
                "pb-24 md:pb-0": showFloatingCompose(),
                "bg-[url(/dev-bg-light.svg)]": import.meta.env.DEV,
                "dark:bg-[url(/dev-bg-dark.svg)]": import.meta.env.DEV,
              }}
            >
              <Show when={!isComposeRoute()}>
                <WebPushPromptBanner
                  enabled={!signedAccount.pending &&
                    signedAccount()?.viewer != null}
                  loaded={!signedAccount.pending}
                  vapidPublicKey={signedAccount()?.webPushVapidPublicKey}
                />
              </Show>
              <Suspense fallback={<RouteLoadingFallback />}>
                {props.children}
              </Suspense>
            </main>
            <FloatingComposeButton
              show={showFloatingCompose()}
              username={chromeSignedAccount()?.username}
              $signedAccount={chromeSignedAccount()}
            />
            <NoteComposeModal />
            <Toaster />
          </SidebarProvider>
        </NoteComposeProvider>
      </ActingAccountProvider>
    </ViewerProvider>
  );
}

interface MobileHeaderNotificationsProps {
  personalUnreadNotificationsCount?: number;
}

function MobileHeaderNotifications(props: MobileHeaderNotificationsProps) {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const notificationBadge = (): OrganizationNotificationBadge | null => {
    const organization = actingAccount.selectedOrganization();
    if (organization != null) {
      return organization.notificationBadge ?? null;
    }
    const count = props.personalUnreadNotificationsCount ?? 0;
    return count > 0 ? { color: "RED", count } : null;
  };

  return (
    <Button
      as={A}
      href="/notifications"
      onClick={invalidateNotificationsPageQueryCache}
      variant="ghost"
      size="icon"
      class="relative size-9 rounded-full"
      aria-label={t`Notifications`}
      title={t`Notifications`}
    >
      <NotificationsBellIcon class="size-5" />
      <Show when={(notificationBadge()?.count ?? 0) > 0}>
        <span
          class="absolute right-2 top-2 size-2.5 rounded-full ring-2 ring-background"
          classList={{
            "bg-red-500": notificationBadge()?.color === "RED",
            "bg-muted-foreground/40": notificationBadge()?.color !== "RED",
          }}
          aria-hidden="true"
        />
      </Show>
    </Button>
  );
}
