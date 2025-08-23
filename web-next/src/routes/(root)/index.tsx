import { query, type RouteDefinition } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { RootRoutesQuery } from "./__generated__/RootRoutesQuery.graphql.ts";

const RootRoutesQuery = graphql`
  query RootRoutesQuery {
    instanceByHost(host: "hackers.pub") {
      host
      software
      softwareVersion
    }
  }
`;

const loadRoutesQuery = query(
  () =>
    loadQuery<RootRoutesQuery>(useRelayEnvironment()(), RootRoutesQuery, {}),
  "loadRoutesQuery",
);

export const route = {
  preload() {
    void loadRoutesQuery();
  },
} satisfies RouteDefinition;

export default function Home() {
  const { t } = useLingui();
  const data = createPreloadedQuery<RootRoutesQuery>(
    RootRoutesQuery,
    loadRoutesQuery,
  );

  return (
    <main>
      <Show when={data()?.instanceByHost}>
        {(instance) => (
          <>
            {t`${instance().host} running ${instance().software} ${instance().softwareVersion}`}
          </>
        )}
      </Show>
    </main>
  );
}
