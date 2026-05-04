import { withSentryErrorBoundary } from "@sentry/solidstart";
import { withSentryRouterRouting } from "@sentry/solidstart/solidrouter";
import { MetaProvider } from "@solidjs/meta";
import { query, Router } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { ErrorBoundary, type ParentProps, Show, Suspense } from "solid-js";
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

// Solid Router HOC that adds Sentry navigation/route tracing on top of the
// stock router. Pair with `solidRouterBrowserTracingIntegration()` in
// entry-client.tsx so client-side navigations show up as transactions.
const SentryRouter = withSentryRouterRouting(Router);

// Solid's built-in <ErrorBoundary> swallows exceptions thrown from
// descendant components. Wrapping it with Sentry's HOC forwards the
// caught error to Sentry first so we hear about render-time crashes
// instead of just seeing a blank fallback in the UI.
const SentryErrorBoundary = withSentryErrorBoundary(ErrorBoundary);

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
    <Show keyed when={!data.pending && data()}>
      {(data) => (
        <I18nProvider $query={data}>
          {props.children}
        </I18nProvider>
      )}
    </Show>
  );
}

export default function App() {
  const environment = createEnvironment();

  return (
    <SentryRouter
      root={(props) => (
        <RelayEnvironmentProvider environment={environment}>
          <MetaProvider>
            <Title>Hackers' Pub</Title>
            <Suspense>
              <I18nProviderWrapper>
                <SentryErrorBoundary
                  fallback={(err) => (
                    <div class="p-6">
                      <h1 class="text-xl font-bold">Something went wrong</h1>
                      <p class="mt-2 text-sm text-muted-foreground">
                        {err instanceof Error ? err.message : String(err)}
                      </p>
                    </div>
                  )}
                >
                  {props.children}
                </SentryErrorBoundary>
              </I18nProviderWrapper>
            </Suspense>
          </MetaProvider>
        </RelayEnvironmentProvider>
      )}
    >
      <Routes />
    </SentryRouter>
  );
}
