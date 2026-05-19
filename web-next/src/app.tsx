import { withSentryErrorBoundary } from "@sentry/solidstart";
import { withSentryRouterRouting } from "@sentry/solidstart/solidrouter";
import { MetaProvider } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { graphql } from "relay-runtime";
import {
  createMemo,
  ErrorBoundary,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  RelayEnvironmentProvider,
  useRelayEnvironment,
} from "solid-relay";
import { Title } from "~/components/Title.tsx";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { isNetworkError } from "~/lib/networkError.ts";
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
import { routePreloadedQuery } from "~/lib/relayPreload.ts";

const appQuery = graphql`
  query appQuery {
    ...i18nProviderLoadI18n_query
  }
`;

const loadAppQuery = routePreloadedQuery(
  () =>
    loadQuery<appQuery>(
      useRelayEnvironment()(),
      appQuery,
      {},
    ),
  "loadAppQuery",
);

function I18nProviderWrapper(props: ParentProps) {
  const rawData = createPreloadedQuery<appQuery>(
    appQuery,
    () => loadAppQuery(),
  );
  // Hold the last non-null query result so that a transient undefined during
  // re-fetch (caused by routePreloadedQuery's reactive signal update) does not
  // flip the Show condition and unmount the entire app tree — including the
  // sidebar and all route content — for the duration of the flash.
  const data = createMemo<ReturnType<typeof rawData> | undefined>(
    (prev) => rawData() ?? prev,
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <I18nProvider $query={data}>
          {props.children}
        </I18nProvider>
      )}
    </Show>
  );
}

// Fallback rendered by the outermost boundary, which sits outside
// I18nProviderWrapper. Because there is no I18nProvider in scope at this
// level, it must not call useLingui() — all strings are hard-coded in English.
function PreI18nErrorFallback(props: { error: unknown; reset: () => void }) {
  const networkError = () => isNetworkError(props.error);
  return (
    <div class="p-6 space-y-4">
      <h1 class="text-xl font-bold">
        {networkError()
          ? "We couldn't reach the server"
          : "Something went wrong"}
      </h1>
      <p class="text-sm text-muted-foreground">
        {networkError()
          ? "Your connection looks unstable. Check your network and try again."
          : props.error instanceof Error
          ? props.error.message
          : String(props.error)}
      </p>
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium rounded-md border"
        onClick={() => props.reset()}
      >
        Try again
      </button>
    </div>
  );
}

// Rendered when the descendant tree throws. Pulls i18n through `useLingui`
// so the boundary itself can be translated, and special-cases transient
// network errors (the Relay retry budget is exhausted, or the failure
// came from a non-Relay path that has no retry of its own) with a
// friendlier message — the raw stacktrace text is unhelpful for a
// "connection dropped" condition the user can resolve themselves.
function AppErrorFallback(props: { error: unknown; reset: () => void }) {
  const { t } = useLingui();
  const networkError = () => isNetworkError(props.error);
  return (
    <div class="p-6 space-y-4">
      <h1 class="text-xl font-bold">
        {networkError()
          ? t`We couldn't reach the server`
          : t`Something went wrong`}
      </h1>
      <p class="text-sm text-muted-foreground">
        {networkError()
          ? t`Your connection looks unstable. Check your network and try again.`
          : props.error instanceof Error
          ? props.error.message
          : String(props.error)}
      </p>
      <Button onClick={() => props.reset()}>{t`Try again`}</Button>
    </div>
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
            <SentryErrorBoundary
              fallback={(err, reset) => (
                <PreI18nErrorFallback error={err} reset={reset} />
              )}
            >
              <Suspense>
                <I18nProviderWrapper>
                  <SentryErrorBoundary
                    fallback={(err, reset) => (
                      <AppErrorFallback error={err} reset={reset} />
                    )}
                  >
                    {props.children}
                  </SentryErrorBoundary>
                </I18nProviderWrapper>
              </Suspense>
            </SentryErrorBoundary>
          </MetaProvider>
        </RelayEnvironmentProvider>
      )}
    >
      <Routes />
    </SentryRouter>
  );
}
