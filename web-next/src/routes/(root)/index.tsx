import { Navigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { loadQuery, useRelayEnvironment } from "solid-relay";
import type { RootRoutesQuery } from "./__generated__/RootRoutesQuery.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

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
  const data = createStablePreloadedQuery<RootRoutesQuery>(
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
              <Navigate href="/news" />
            </Match>
          </Switch>
        </>
      )}
    </Show>
  );
}
