import { Navigate, useLocation } from "@solidjs/router";
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
  const location = useLocation();
  const hrefWithLang = (href: string) => {
    const value = location.query.lang;
    const lang = Array.isArray(value) ? value[0] : value;
    if (!lang) return href;
    return `${href}?${new URLSearchParams({ lang }).toString()}`;
  };
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
              <Navigate href={hrefWithLang("/feed")} />
            </Match>
            <Match when={data.viewer == null}>
              <Navigate href={hrefWithLang("/news")} />
            </Match>
          </Switch>
        </>
      )}
    </Show>
  );
}
