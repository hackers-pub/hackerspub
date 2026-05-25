import {
  A,
  type RouteDefinition,
  type RouteSectionProps,
  useLocation,
} from "@solidjs/router";
import * as Sentry from "@sentry/solidstart";
import { createRenderEffect, createSignal, onMount, Suspense } from "solid-js";
import { graphql } from "relay-runtime";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { AppSidebar } from "~/components/AppSidebar.tsx";
import { FloatingComposeButton } from "~/components/FloatingComposeButton.tsx";
import { NoteComposeModal } from "~/components/NoteComposeModal.tsx";
import { SidebarProvider, SidebarTrigger } from "~/components/ui/sidebar.tsx";
import { Toaster } from "~/components/ui/toast.tsx";
import { WebPushPromptBanner } from "~/components/WebPushPromptBanner.tsx";
import { NoteComposeProvider } from "~/contexts/NoteComposeContext.tsx";
import { ViewerProvider } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { RootLayoutQuery } from "./__generated__/RootLayoutQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

export const route = {
  preload() {
    void loadRootLayoutQuery();
  },
} satisfies RouteDefinition;

const RootLayoutQuery = graphql`
  query RootLayoutQuery {
    webPushVapidPublicKey
    viewer {
      uuid
      username
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
  const showFloatingCompose = () => {
    if (!chromeSignedAccountLoaded() || !chromeSignedAccount()) return false;
    return !/^\/(?:@[^/]+\/(?:drafts|settings)|sign)(?:\/|$)/.test(
      location.pathname,
    );
  };
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
    >
      <NoteComposeProvider>
        <SidebarProvider>
          <AppSidebar
            $signedAccount={chromeSignedAccount()}
            signedAccountLoaded={chromeSignedAccountLoaded()}
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
              <div class="size-9" aria-hidden="true" />
            </div>
          </header>
          <main
            lang={new Intl.Locale(i18n.locale).minimize().baseName}
            class="w-full pt-14 md:pt-0"
            classList={{
              "pb-24 md:pb-0": showFloatingCompose(),
              "bg-[url(/dev-bg-light.svg)]": import.meta.env.DEV,
              "dark:bg-[url(/dev-bg-dark.svg)]": import.meta.env.DEV,
            }}
          >
            <WebPushPromptBanner
              enabled={!signedAccount.pending &&
                signedAccount()?.viewer != null}
              loaded={!signedAccount.pending}
              vapidPublicKey={signedAccount()?.webPushVapidPublicKey}
            />
            <Suspense>{props.children}</Suspense>
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
    </ViewerProvider>
  );
}
