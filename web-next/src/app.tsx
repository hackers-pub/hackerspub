import { MetaProvider } from "@solidjs/meta";
import { query, Router } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { type ParentProps, Show, Suspense } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  RelayEnvironmentProvider,
  useRelayEnvironment,
} from "solid-relay";
import { Title } from "~/components/Title.tsx";
import { createEnvironment } from "./RelayEnvironment.tsx";
import type { appQuery } from "./__generated__/appQuery.graphql.ts";
import { I18nProvider } from "./lib/i18n/index.tsx";
import Routes from "./routes.tsx";

import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "~/app.css";

const appQuery = graphql`
  query appQuery {
    ...i18nProviderLoadI18n_query
  }
`;

const loadAppQuery = query(
  () =>
    loadQuery<appQuery>(
      useRelayEnvironment()(),
      appQuery,
      {},
    ),
  "loadAppQuery",
);

function I18nProviderWrapper(props: ParentProps) {
  const data = createPreloadedQuery<appQuery>(
    appQuery,
    () => loadAppQuery(),
  );

  return (
    <Show when={!data.pending && data()}>
      {(data) => (
        <I18nProvider $query={data()}>
          {props.children}
        </I18nProvider>
      )}
    </Show>
  );
}

export default function App() {
  const environment = createEnvironment();

  return (
    <Router
      root={(props) => (
        <RelayEnvironmentProvider environment={environment}>
          <MetaProvider>
            <Title>Hackers' Pub</Title>
            <Suspense>
              <I18nProviderWrapper>
                {props.children}
              </I18nProviderWrapper>
            </Suspense>
          </MetaProvider>
        </RelayEnvironmentProvider>
      )}
    >
      <Routes />
    </Router>
  );
}
