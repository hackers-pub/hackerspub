import { Navigate, query, type RouteDefinition } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import type { RootRoutesQuery } from "./__generated__/RootRoutesQuery.graphql.ts";

export const route = {
  preload() {
    void loadRoutesQuery();
  },
} satisfies RouteDefinition;

const RootRoutesQuery = graphql`
  query RootRoutesQuery {
    viewer {
      id
    }
  }
`;

const loadRoutesQuery = query(
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
    <Show when={data()}>
      {(data) => (
        <>
          <Switch>
            <Match when={data().viewer != null}>
              <Navigate href="/feed" />
            </Match>
            <Match when={data().viewer == null}>
              <Navigate href="/local" />
            </Match>
          </Switch>
        </>
      )}
    </Show>
  );
}
