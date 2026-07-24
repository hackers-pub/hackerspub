// @refresh reload
// Polyfill Temporal for the Node.js runtime. Deno (used by the GraphQL API and
// worker) exposes Temporal natively as an unstable API, but Node has not shipped
// it yet. Several modules in @hackerspub/models reference Temporal at
// module init (e.g. session.ts's `EXPIRATION = Temporal.Duration.from(...)`),
// so this must run before any of those chunks load.
//
// The package's documented form is `import "temporal-polyfill/global"`,
// but Nitro's bundler drops the side-effect-only import despite the
// package's `sideEffects` declaration. Importing a binding and assigning
// it manually keeps the polyfill in the bundle.
import { Temporal as TemporalPolyfill } from "temporal-polyfill";
(globalThis as { Temporal?: typeof TemporalPolyfill }).Temporal ??=
  TemporalPolyfill;

// Aliased to avoid clashing with the auto-injected `import process`.
import nodeProcess from "node:process";
import {
  createHandler,
  type PageEvent,
  StartServer,
} from "@solidjs/start/server";

// Read the Sentry DSN from the runtime environment, NOT at build time —
// the Docker image is public, so a baked-in DSN would leak. The value
// is rendered into an inline script below so the client picks it up
// before entry-client.mjs runs (deferred module scripts).
const SENTRY_DSN_SCRIPT = `window.__SENTRY_DSN__=${JSON.stringify(
  nodeProcess.env.SENTRY_DSN ?? "",
)};`;

function isEnabledRuntimeFlag(name: string): boolean {
  const value = nodeProcess.env[name]?.trim().toLowerCase();
  return value != null && value !== "" && value !== "false" && value !== "0";
}

// Keep Plausible opt-in runtime-only for the same reason as Sentry: the
// public Docker image should not decide analytics behavior at build time.
const PLAUSIBLE_SCRIPT = `window.__PLAUSIBLE__=${JSON.stringify(
  isEnabledRuntimeFlag("PLAUSIBLE"),
)};`;

function removeInitialModulePreloads(context: PageEvent): void {
  context.assets = context.assets.filter(
    (asset) => asset?.tag !== "link" || asset.attrs?.rel !== "modulepreload",
  );
}

// Sentry's automatic instrumentation (set up in instrument.server.mjs and
// activated by `node --import` before this module loads) hooks the Node
// HTTP server, uncaught exceptions, and unhandled rejections via
// `httpIntegration` / `onUncaughtExceptionIntegration` /
// `onUnhandledRejectionIntegration`. That covers SSR and server-function
// errors without needing to wrap `createHandler` here. Errors that get
// swallowed by Solid (e.g. inside Relay's network layer) are reported
// explicitly with `captureException` at their source — see
// RelayEnvironment.tsx.
export default createHandler(
  (context) => {
    removeInitialModulePreloads(context);
    return (
      <StartServer
        document={({ assets, children, scripts }) => (
          <html>
            <head>
              <meta charset="utf-8" />
              <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
              />
              <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
              <link
                rel="alternate icon"
                type="image/x-icon"
                href="/favicon.ico"
                sizes="16x16 32x32 48x48 256x256"
              />
              <link rel="apple-touch-icon" href="/apple-icon-180.png" />
              <link rel="manifest" href="/manifest.json" />
              <meta name="theme-color" content="#000000" />
              <script innerHTML={SENTRY_DSN_SCRIPT} />
              <script innerHTML={PLAUSIBLE_SCRIPT} />
              {assets}
            </head>
            <body>
              <div id="app">{children}</div>
              {scripts}
            </body>
          </html>
        )}
      />
    );
  },
  { mode: "async" },
);
