import { Navigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import type { RootRoutesQuery } from "./__generated__/RootRoutesQuery.graphql.ts";
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

const RootRoutesQuery = graphql`
  query RootRoutesQuery {
    viewer {
      id
    }
  }
`;

const loadRoutesQuery = routePreloadedQuery(
  () =>
    loadQuery<RootRoutesQuery>(useRelayEnvironment()(), RootRoutesQuery, {}),
  "loadRoutesQuery",
);

export default function Home() {
  const data = createPreloadedQuery<RootRoutesQuery>(
    RootRoutesQuery,
    () => loadRoutesQuery(),
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <>
          <Switch>
            <Match when={data.viewer != null}>
              <Navigate href="/feed" />
            </Match>
            <Match when={data.viewer == null}>
              <Navigate href="/local" />
            </Match>
          </Switch>
        </>
      )}
    </Show>
  );
}
