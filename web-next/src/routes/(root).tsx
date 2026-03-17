import {
  A,
  query,
  type RouteDefinition,
  type RouteSectionProps,
} from "@solidjs/router";
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
import { NoteComposeProvider } from "~/contexts/NoteComposeContext.tsx";
import { ViewerProvider } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { RootLayoutQuery } from "./__generated__/RootLayoutQuery.graphql.ts";

export const route = {
  preload() {
    void loadRootLayoutQuery();
  },
} satisfies RouteDefinition;

const RootLayoutQuery = graphql`
  query RootLayoutQuery {
    viewer {
      username
      ...AppSidebar_signedAccount
      ...FloatingComposeButton_signedAccount
    }
  }
`;

const loadRootLayoutQuery = query(
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
  const signedAccount = createPreloadedQuery<RootLayoutQuery>(
    RootLayoutQuery,
    () => loadRootLayoutQuery(),
  );
  return (
    <ViewerProvider
      isAuthenticated={() =>
        !signedAccount.pending && !!signedAccount()?.viewer}
      isLoaded={() => !signedAccount.pending}
    >
      <NoteComposeProvider>
        <SidebarProvider>
          <AppSidebar
            $signedAccount={signedAccount()?.viewer}
            signedAccountLoaded={!signedAccount.pending}
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
            class="w-160 mx-auto pt-14 md:pt-0"
            classList={{
              "bg-[url(/dev-bg-light.svg)]": import.meta.env.DEV,
              "dark:bg-[url(/dev-bg-dark.svg)]": import.meta.env.DEV,
            }}
          >
            {props.children}
          </main>
          <FloatingComposeButton
            show={!signedAccount.pending && !!signedAccount()?.viewer}
            username={signedAccount()?.viewer?.username}
            $signedAccount={signedAccount()?.viewer}
          />
          <NoteComposeModal />
          <Toaster />
        </SidebarProvider>
      </NoteComposeProvider>
    </ViewerProvider>
  );
}
