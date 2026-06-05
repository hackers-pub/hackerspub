// Sentry initialization for the GraphQL server. Imported as the very first
// statement in main.ts so it runs before any of the other module-init code
// that could throw — that way uncaught exceptions during startup also
// reach Sentry. Stays a no-op when SENTRY_DSN is unset (local dev,
// PR builds, forks without an account), matching the pattern used by
// web-next's instrument.server.mjs.
import { getLogger } from "@logtape/logtape";
import * as Sentry from "@sentry/deno";
import metadata from "./deno.json" with { type: "json" };
import { isRemoteTransportError } from "./logFilter.ts";

const dsn = Deno.env.get("SENTRY_DSN");
if (dsn) {
  Sentry.init({
    dsn,
    // Tag every event with the build's release identifier — same scheme
    // web-next uses (`<base>+<git_commit>` after the Dockerfile's jq
    // step) so Sentry can match symbols and group across deploys.
    release: metadata.version,
    // Turn on Sentry's structured Logs API at the SDK level so the
    // @logtape/sentry sink (graphql/logging.ts) can actually deliver
    // records through it; without this they'd be dropped on the
    // client side before reaching Sentry.
    enableLogs: true,
    sendDefaultPii: true,
    // Enable performance tracing. Required for vercelAIIntegration's
    // AI-call spans to actually be captured. 1.0 = every request
    // traced; tune downward (e.g. 0.1) once we know the volume.
    tracesSampleRate: 1.0,
    // Function form so we can drop one default integration while keeping the
    // rest. The default `GlobalHandlers` integration's `unhandledrejection`
    // handler captures, flushes, then *rethrows* to replicate Deno's
    // exit-on-unhandled-rejection (see @sentry/deno's globalhandlers.js) —
    // which would defeat the `unhandledrejection` listener below that
    // deliberately keeps the process alive. Disable just that half (keep its
    // `error` handler so uncaught *sync* exceptions still crash + report as
    // before); the listener below reports the rejection itself, capturing
    // directly via this @sentry/deno client (see the note there).
    integrations: (defaultIntegrations) => [
      ...defaultIntegrations.filter((i) => i.name !== "GlobalHandlers"),
      Sentry.globalHandlersIntegration({
        error: true,
        unhandledrejection: false,
      }),
      // Wraps the Vercel AI SDK so each `generateText` / `streamText` /
      // similar call shows up as a span with model, prompt tokens,
      // latency, etc. Inputs/outputs default to recorded because
      // sendDefaultPii is on. Not a default integration, so it must be
      // listed explicitly here (the function form replaces the default list).
      Sentry.vercelAIIntegration(),
      // `Sentry.denoContextIntegration` is included automatically by the SDK's
      // default integrations (preserved by the spread above), so we don't list
      // it here — it tags every event with Deno runtime / OS / V8 / TS context.
      //
      // `Sentry.denoRuntimeMetricsIntegration()` was here too but crashes
      // at startup with `TypeError: expected f64` from
      // `Deno.unrefTimer(intervalId)` — the npm-shipped build receives
      // Node's `Timeout` object from `setInterval` instead of the f64 the
      // Deno runtime expects. Re-enable once @sentry/deno fixes this
      // (tracked upstream).
    ],
  });
}

// Last-resort safety net for *detached* promise rejections. Deno terminates
// the process on an unhandled rejection, so a single fire-and-forget promise
// that rejects — e.g. an outbound `fetch`/`node:http` request whose body
// stream errors with "resource closed" when a peer connection is torn down
// mid-flight — would take down a whole GraphQL replica. Such a rejection
// escapes the request-handler try/catch and the Envelop Sentry plugin, so it
// never reached Sentry either; the only visible symptom was a burst of
// downstream gateway timeouts (Caddy 504s) while the replica restarted.
// Suppress the default termination so the server keeps serving, and report
// the rejection so it stays visible. This is a backstop, NOT a license to leak
// promises: every event it catches is a real bug whose source still needs an
// explicit `.catch`.
//
// We capture to Sentry directly via `Sentry.captureException` (not via the
// LogTape -> Sentry sink) so the rejection lands as a proper *exception* event
// with a stacktrace and `onunhandledrejection` mechanism, rather than as a
// structured log event.  The LogTape call below uses `.warning()` (below the
// sink's `error`-level threshold) so it reaches the console/file sinks for
// structured logging but does NOT generate a second, duplicate Sentry event.
// Logging at `.error()` would cause both paths to fire simultaneously now that
// the sink is wired to the same v10 Sentry client (fixed in 62ccf80a).
//
// Registered unconditionally (even without SENTRY_DSN): keeping a replica
// alive through a stray rejection is the right behavior in dev too, and
// `Sentry.captureException` is a no-op until `Sentry.init` runs.
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const { reason } = event;
  // Remote-peer failures (transport errors, jsonld.InvalidUrl from a bad
  // @context URL, etc.) can escape Fedify's inbox try-catch as unhandled
  // rejections. They are not application bugs, so log at warning level and
  // skip Sentry rather than filing false-positive issues (GRAPHQL-1J).
  if (isRemoteTransportError(reason)) {
    getLogger(["hackerspub", "graphql"]).warning(
      "Remote peer error escaped as unhandled rejection: {error}",
      { error: reason },
    );
    return;
  }
  getLogger(["hackerspub", "graphql"]).warning(
    "Unhandled promise rejection suppressed to keep the server alive: {error}",
    { error: reason },
  );
  Sentry.captureException(reason, {
    mechanism: { type: "onunhandledrejection", handled: false },
  });
});
