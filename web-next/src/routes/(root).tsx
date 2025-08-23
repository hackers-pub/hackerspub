import {
  query,
  RouteDefinition,
  type RouteSectionProps,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { AppSidebar } from "~/components/AppSidebar.tsx";
import { SidebarProvider } from "~/components/ui/sidebar.tsx";
import { Toaster } from "~/components/ui/toast.tsx";
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
  const { i18n } = useLingui();
  const signedAccount = createPreloadedQuery<RootLayoutQuery>(
    RootLayoutQuery,
    () => loadRootLayoutQuery(),
  );
  return (
    <SidebarProvider>
      <AppSidebar
        $signedAccount={signedAccount()?.viewer}
        signedAccountLoaded={!signedAccount.pending}
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
      <Toaster />
    </SidebarProvider>
  );
}
