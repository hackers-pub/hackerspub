import { query, type RouteDefinition } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import type { routesQuery } from "./__generated__/routesQuery.graphql.ts";

const RoutesQuery = graphql`
  query routesQuery {
    instanceByHost(host: "hackers.pub") {
      host
      software
      softwareVersion
    }
  }
`;

const loadRoutesQuery = query(
  () => loadQuery<routesQuery>(useRelayEnvironment()(), RoutesQuery, {}),
  "loadRoutesQuery",
);

export const route = {
  preload() {
    void loadRoutesQuery();
  },
} satisfies RouteDefinition;

export default function Home() {
  const data = createPreloadedQuery<routesQuery>(
    RoutesQuery,
    loadRoutesQuery,
  );

  return (
    <main>
      <Show when={data()?.instanceByHost}>
        {(instance) => (
          <>
            {instance().host} running {instance().software}{" "}
            {instance().softwareVersion}
          </>
        )}
      </Show>
    </main>
  );
}
