import {
  query,
  RouteDefinition,
  type RouteSectionProps,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { type ParentProps, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { AppSidebar } from "~/components/AppSidebar.tsx";
import { Navigation } from "~/components/Navigation.tsx";
import { NoteComposeModal } from "~/components/NoteComposeModal.tsx";
import { SidebarProvider, useSidebar } from "~/components/ui/sidebar.tsx";
import { Toaster } from "~/components/ui/toast.tsx";
import { NoteComposeProvider } from "~/contexts/NoteComposeContext.tsx";
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
      ...AppSidebar_signedAccount
      ...Navigation_signedAccount
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
  const signedAccount = createPreloadedQuery<RootLayoutQuery>(
    RootLayoutQuery,
    () => loadRootLayoutQuery(),
  );
  return (
    <NoteComposeProvider>
      <SidebarProvider>
        <RootLayoutContent signedAccount={signedAccount}>
          {props.children}
        </RootLayoutContent>
      </SidebarProvider>
    </NoteComposeProvider>
  );
}

function RootLayoutContent(
  props: ParentProps<{
    signedAccount: ReturnType<typeof createPreloadedQuery<RootLayoutQuery>>;
  }>,
) {
  const { i18n } = useLingui();
  const { isMobile } = useSidebar();

  return (
    <>
      <AppSidebar
        $signedAccount={props.signedAccount()?.viewer}
        signedAccountLoaded={!props.signedAccount.pending}
      />
      <main
        lang={new Intl.Locale(i18n.locale).minimize().baseName}
        class="w-full"
        classList={{
          "bg-[url(/dev-bg-light.svg)]": import.meta.env.DEV,
          "dark:bg-[url(/dev-bg-dark.svg)]": import.meta.env.DEV,
        }}
      >
        {props.children}
      </main>
      <Show when={isMobile() && props.signedAccount()?.viewer}>
        {(viewer) => <Navigation $signedAccount={viewer()} />}
      </Show>
      <NoteComposeModal />
      <Toaster />
    </>
  );
}
