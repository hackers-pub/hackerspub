import { MetaProvider, Title } from "@solidjs/meta";
import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import { RelayEnvironmentProvider } from "solid-relay";
import { createEnvironment } from "./RelayEnvironment.tsx";
import { I18nProvider } from "./lib/i18n/index.tsx";

import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "~/app.css";

export default function App() {
  const environment = createEnvironment();

  return (
    <Router
      root={(props) => (
        <RelayEnvironmentProvider environment={environment}>
          <MetaProvider>
            <Title>Hackers' Pub</Title>
            <Suspense>
              <I18nProvider>
                {props.children}
              </I18nProvider>
            </Suspense>
          </MetaProvider>
        </RelayEnvironmentProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
