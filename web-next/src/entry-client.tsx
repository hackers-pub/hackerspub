// @refresh reload
import { installHeaderAnchorLinks } from "@hackerspub/models/header-anchor";
import { init as initPlausible } from "@plausible-analytics/tracker";
import * as Sentry from "@sentry/solidstart";
import { solidRouterBrowserTracingIntegration } from "@sentry/solidstart/solidrouter";
import { mount, StartClient } from "@solidjs/start/client";
import { render } from "solid-js/web";
import { startClientMemoryWatchdog } from "~/lib/clientMemoryWatchdog.ts";
import { isNetworkError } from "~/lib/networkError.ts";
import { installPromiseWithResolversPolyfill } from "~/lib/promiseWithResolvers.ts";
import { isTransientUpstreamGraphQLErrorEvent } from "~/lib/upstreamGraphQLError.ts";
import packageJson from "../package.json" with { type: "json" };

installPromiseWithResolversPolyfill();

if (import.meta.env.DEV) {
  void import("~/lib/installSolidDevtools.ts");
}

// SENTRY_DSN is injected at runtime by the SSR document (entry-server.tsx)
// as `window.__SENTRY_DSN__`. The inline script that sets it runs before
// this module (deferred via `type="module"`), so the value is ready by
// the time we read it. When unset, Sentry just stays disabled.
const sentryDsn = (window as { __SENTRY_DSN__?: string }).__SENTRY_DSN__ ?? "";
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    // Tag every event with the deployed version so Sentry can group
    // errors by release. The Dockerfile turns this into
    // `0.2.0+<git_commit>` per build (see the jq step), and the Sentry
    // Vite plugin uploads source maps under the matching release name
    // (vite.config.ts), so symbolication lines up.
    release: packageJson.version,
    integrations: [
      // Tracks client-side navigations as transactions — pairs with the
      // `withSentryRouterRouting(Router)` wrapper in app.tsx so the
      // generated transaction names match the Solid Router routes the
      // user actually visits.
      solidRouterBrowserTracingIntegration(),
    ],
    // Send default PII (e.g. IP address) so we can correlate errors with
    // users where useful.
    sendDefaultPii: true,
    beforeSend(event, hint) {
      if (isTransientUpstreamGraphQLErrorEvent(event, hint)) return null;
      if (isNetworkError(hint.originalException)) return null;
      return event;
    },
  });
  startClientMemoryWatchdog();
}

// PLAUSIBLE is injected at runtime by the SSR document (entry-server.tsx).
// Keep initialization client-only because the tracker relies on browser APIs.
const plausibleEnabled =
  (window as { __PLAUSIBLE__?: boolean }).__PLAUSIBLE__ ?? false;
if (plausibleEnabled) {
  initPlausible({
    domain: window.location.hostname,
    outboundLinks: true,
  });
}

// Recover from stale dynamic-import failures after a deploy. When a new
// build replaces the hashed chunks under `/_build/assets/`, any tab
// still holding HTML from the previous build will 404 the next time
// the router fetches a route chunk. Vite emits `vite:preloadError` for
// exactly this case (cancelable; payload carries the original Error),
// so we listen there instead of pattern-matching browser-specific
// messages on `unhandledrejection`. We do NOT call `preventDefault()`:
// if prevented, Vite resolves the import with `undefined` instead of
// rejecting, which causes Solid's lazy() to throw a confusing secondary
// error. We let Vite propagate the rejection cleanly and reload instead.
// https://vite.dev/guide/build#load-error-handling

// Throttle reloads rather than allowing only one ever: if a reload
// itself blows up the same way within this window (e.g. the new chunk
// really is gone, not just stale), give up so the user sees an error
// instead of refreshing forever. A real recovery completes in well
// under a second, so 10s is plenty. Outside the window — say, hours
// later when another deploy lands — we recover again.
const RELOAD_GUARD_KEY = "hp:stale-chunk-reload-at";
const RELOAD_GUARD_WINDOW_MS = 10_000;

function shouldAttemptStaleChunkReload(): boolean {
  // sessionStorage access can throw in private modes or when storage
  // is blocked by the browser. We deliberately skip the reload in
  // that case rather than guessing: an unthrottled reload on a
  // permanently-missing chunk would loop forever, and silently
  // looping is worse than the user seeing the error and refreshing
  // manually.
  try {
    const lastAttempt = Number(
      window.sessionStorage.getItem(RELOAD_GUARD_KEY) ?? "0",
    );
    if (Date.now() - lastAttempt < RELOAD_GUARD_WINDOW_MS) return false;
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

window.addEventListener("vite:preloadError", (event) => {
  // On the throttled path, return early and let Vite rethrow naturally
  // so Sentry's global `unhandledrejection` handler captures the error
  // without a manual capture (avoiding duplicate events).
  if (!shouldAttemptStaleChunkReload()) return;
  Sentry.addBreadcrumb({
    category: "vite",
    level: "info",
    message: "Reloading after stale module preload error.",
    data: {
      error:
        event.payload instanceof Error
          ? event.payload.message
          : String(event.payload),
    },
  });
  console.info("Reloading after stale module preload error.", event.payload);
  // Do NOT call event.preventDefault(). When prevented, Vite's
  // __vitePreload wrapper resolves the dynamic import with `undefined`
  // instead of rejecting it. Solid's lazy() then stores
  // `comp = () => mod.default` with mod===undefined, so when the
  // component renders, `comp()` throws "Cannot read properties of
  // undefined (reading 'default')" — a secondary error unrelated to
  // the real cause. Without preventDefault the original rejection
  // propagates cleanly through Solid's error path, and the error
  // boundary surfaces the actual "Failed to fetch dynamically imported
  // module" message. The stale-chunk recovery still works via reload().
  location.reload();
});

const app = document.getElementById("app");
if (app == null) throw new Error("#app element not found");

const disposeHydration = mount(() => <StartClient />, app);
installHeaderAnchorLinks(document);

function hasHydrationNodes(element: Element): boolean {
  // Solid may leave only comment/template markers in #app while a root
  // Suspense boundary is still waiting. Those nodes still mean hydration is
  // alive, so only recover when the container is truly empty.
  if (!element.hasChildNodes()) return false;
  // If hydration failed and an error boundary rendered a fallback, the
  // resulting DOM has no [data-hk] markers. Treat that as a hydration
  // failure and let the fallback below re-mount as a pure client render
  // so the user doesn't see a permanent "Something went wrong" screen.
  return element.querySelector("[data-hk]") !== null;
}

setTimeout(() => {
  if (hasHydrationNodes(app)) return;

  // Some browser extensions inject nodes outside <head>/<body> before the
  // app boots, which can leave Solid's hydration stuck with an empty #app.
  // Client rendering still works in that state, so recover instead of showing
  // a permanent blank page.
  disposeHydration();
  app.replaceChildren();
  render(() => <StartClient />, app);
}, 1500);
