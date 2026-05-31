import * as Sentry from "@sentry/solidstart";
import type {
  FetchFunction,
  GraphQLResponse,
  IEnvironment,
} from "relay-runtime";
import {
  Environment,
  Network,
  Observable,
  RecordSource,
  Store,
} from "relay-runtime";
import { getRequestEvent, isServer } from "solid-js/web";
import { getApiUrl } from "~/lib/env.ts";
import { isNetworkError } from "~/lib/networkError.ts";
import { readSessionCookie } from "~/lib/sessionCookie.ts";

// Errors the upstream produces in response to an authentication
// failure. The GraphQL server tags these with this extension code (see
// graphql/timeline.ts) precisely so we can recognize them here without
// pattern-matching on the user-facing message. Relay's `PayloadError`
// type does not model `extensions`, but Yoga emits them per the
// GraphQL spec, so we read it through a structural narrowing.
const AUTH_REQUIRED_CODE = "AUTHENTICATION_REQUIRED";
const UPSTREAM_BODY_PREVIEW_LENGTH = 2048;

function isExpectedAuthError(errors: ReadonlyArray<unknown>): boolean {
  if (errors.length === 0) return false;
  return errors.every((error) => {
    if (error == null || typeof error !== "object") return false;
    const extensions = (error as { extensions?: unknown }).extensions;
    if (extensions == null || typeof extensions !== "object") return false;
    return (extensions as { code?: unknown }).code === AUTH_REQUIRED_CODE;
  });
}

function isSensitiveResponseHeader(name: string): boolean {
  const headerName = name.toLowerCase();
  return headerName.includes("cookie") ||
    headerName.includes("authorization") ||
    headerName.includes("token") ||
    headerName.includes("secret") ||
    headerName.includes("key");
}

function getSafeResponseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    result[name] = isSensitiveResponseHeader(name) ? "[redacted]" : value;
  }
  return result;
}

function isJsonLikeBody(body: string): boolean {
  const firstNonWhitespace = body.trimStart().at(0);
  return firstNonWhitespace === "{" || firstNonWhitespace === "[";
}

function getBodyPreview(body: string): string {
  if (isJsonLikeBody(body)) {
    return "[omitted: JSON-like response body]";
  }
  if (body.length <= UPSTREAM_BODY_PREVIEW_LENGTH) return body;
  return `${body.slice(0, UPSTREAM_BODY_PREVIEW_LENGTH)}... [truncated ${
    body.length - UPSTREAM_BODY_PREVIEW_LENGTH
  } chars]`;
}

function getUpstreamResponseDiagnostics(
  response: Response,
  body?: string,
): Record<string, unknown> {
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    url: response.url,
    redirected: response.redirected,
    headers: getSafeResponseHeaders(response.headers),
    bodyLength: body?.length,
    bodyPreview: body == null ? undefined : getBodyPreview(body),
  };
}

// The session cookie doubles as the GraphQL bearer token (see the
// `Authorization` header below), is the lookup key in the session KV, and
// is long-lived — so it's an auth credential, not just an identifier.
// Hash it before sending to Sentry so the value in Sentry's UI can't be
// replayed as a session token. SHA-256 is one-way; truncating to 16 bytes
// is plenty of entropy for per-session grouping.
async function fingerprintSessionId(sessionId: string): Promise<string> {
  const data = new TextEncoder().encode(sessionId);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "session:" + hex.slice(0, 32);
}

const fetchFn: FetchFunction = async (
  params,
  variables,
) => {
  "use server";

  if (!params.text) throw new Error("Operation document must be provided");

  const event = getRequestEvent();
  const sessionId = readSessionCookie(event?.request);
  // Propagate the inbound request's abort signal to the upstream fetch so
  // that when the client unsubscribes the Relay observable (which closes
  // the inbound `/_server` request), the GraphQL server — and any AI work
  // it's blocked on, e.g. alt-text generation — gets cancelled too instead
  // of running to completion uselessly.
  const upstreamSignal = event?.request.signal;
  // Per-event user identity for any Sentry capture below. Relay loaders
  // fire from `route.preload()` (e.g. the layout's own `loadRootLayoutQuery`)
  // before any component renders, which is before `(root).tsx`'s render
  // effect can call `Sentry.setUser` — so without this, SSR-side captures
  // of preload-time GraphQL failures would have no user context. Setting
  // `user` on the CaptureContext scopes the identity to a single event
  // instead of mutating the request's isolation scope, so it doesn't
  // conflict with the account-uuid-based `setUser` the layout fires once
  // the viewer query resolves later in the same request.
  const userIdentity = sessionId == null
    ? undefined
    : { id: await fingerprintSessionId(sessionId) };

  let response: Response;
  let responseText: string;
  let body: GraphQLResponse;
  try {
    response = await fetch(getApiUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...sessionId == null ? {} : {
          "Authorization": "Bearer " + sessionId,
        },
      },
      credentials: "include",
      body: JSON.stringify({ query: params.text, variables }),
      signal: upstreamSignal,
    });
  } catch (cause) {
    // The client unsubscribed (e.g. the user clicked Cancel on alt-text
    // generation) and that closed our inbound request, which in turn
    // aborted the upstream fetch. This is a normal cancellation, not a
    // defect — don't page anyone via Sentry. We narrow on the error name
    // rather than just `upstreamSignal.aborted` so that a real fetch /
    // JSON-parse failure that happens to land while an unrelated abort
    // is in flight still gets captured.
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    // Upstream unreachable / connection reset. Relay catches network errors
    // internally and only logs them to the console (see comment below), so
    // without an explicit capture here they wouldn't reach Sentry at all.
    Sentry.captureException(cause, {
      extra: {
        operation: params.name,
        operationKind: params.operationKind,
        query: params.text,
        variables,
      },
      ...(userIdentity == null ? {} : { user: userIdentity }),
    });
    throw cause;
  }

  try {
    responseText = await response.text();
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    Sentry.captureException(cause, {
      extra: {
        operation: params.name,
        operationKind: params.operationKind,
        query: params.text,
        variables,
        upstreamResponse: getUpstreamResponseDiagnostics(response),
      },
      ...(userIdentity == null ? {} : { user: userIdentity }),
    });
    throw cause;
  }

  try {
    body = JSON.parse(responseText) as GraphQLResponse;
  } catch (cause) {
    // When the signal fires after response headers arrive but while the
    // body is still being read, undici may leave us with a truncated body
    // that fails JSON.parse. That is still a normal cancellation when the
    // inbound request signal is aborted.
    if (
      cause instanceof SyntaxError &&
      cause.message === "Unexpected end of JSON input" &&
      upstreamSignal?.aborted
    ) throw cause;
    Sentry.captureException(cause, {
      extra: {
        operation: params.name,
        operationKind: params.operationKind,
        query: params.text,
        variables,
        upstreamResponse: getUpstreamResponseDiagnostics(
          response,
          responseText,
        ),
      },
      ...(userIdentity == null ? {} : { user: userIdentity }),
    });
    throw cause;
  }

  // Relay surfaces upstream GraphQL errors as a generic "Unexpected error"
  // on the client, which makes them impossible to diagnose from logs.
  // Log a structured entry on the SSR side whenever the upstream returns
  // a non-OK status or an `errors` field so we can correlate the failing
  // operation with whatever the GraphQL server actually said, and forward
  // the same context to Sentry. (Default Sentry integrations do not
  // capture Relay errors because Relay catches them internally and only
  // logs to the console — we have to report them by hand.)
  const errors = "errors" in body ? body.errors : undefined;
  if (!response.ok || errors != null) {
    if (response.ok && errors != null && isExpectedAuthError(errors)) {
      // The upstream resolver intentionally rejected an unauthenticated
      // request (e.g. a stale session cookie that survived the route
      // gate). The route layer renders a sign-in redirect for these,
      // so they're not bugs and should not page anyone via Sentry.
      return body;
    }
    const summary = `GraphQL upstream error: ${params.name ?? "<unnamed>"}`;
    console.error("[RelayNetwork upstream error]", {
      operation: params.name,
      operationKind: params.operationKind,
      query: params.text,
      variables,
      status: response.status,
      statusText: response.statusText,
      errors,
    });
    Sentry.captureException(new Error(summary), {
      extra: {
        operation: params.name,
        operationKind: params.operationKind,
        query: params.text,
        variables,
        status: response.status,
        statusText: response.statusText,
        upstreamResponse: getUpstreamResponseDiagnostics(response),
        errors,
      },
      ...(userIdentity == null ? {} : { user: userIdentity }),
    });
  }
  return body;
};

let clientEnvironment: IEnvironment | undefined;
const requestEnvironmentKey = Symbol("relayEnvironment");

// On the client `fetchFn` is replaced by SolidStart's server-function
// proxy, which exposes `withOptions` for binding `RequestInit` (incl.
// `signal`) onto the underlying `fetch` to `/_server`. The proxy isn't
// part of the `FetchFunction` type, so we narrow it ourselves.
type ClientFetchFn = FetchFunction & {
  withOptions: (options: RequestInit) => FetchFunction;
};

function addRelayRequestBreadcrumb(
  params: Parameters<FetchFunction>[0],
  cacheConfig: Parameters<FetchFunction>[2],
): void {
  if (isServer) return;
  Sentry.addBreadcrumb({
    category: "relay.request",
    level: "info",
    message: `${params.operationKind} ${params.name}`,
    data: {
      operation: params.name,
      operationKind: params.operationKind,
      transport: "/_server",
      force: cacheConfig.force,
      hasPersistedId: params.id != null,
    },
  });
}

function isGraphQLSingularResponse(response: unknown): boolean {
  if (response == null || typeof response !== "object") return false;
  if ("data" in response) return isGraphQLData(response.data);
  return "errors" in response &&
    Array.isArray(response.errors) &&
    response.errors.length > 0;
}

function isGraphQLData(data: unknown): boolean {
  return data === null || typeof data === "object" && !Array.isArray(data);
}

function isGraphQLResponse(response: unknown): response is GraphQLResponse {
  return Array.isArray(response)
    ? response.length > 0 && response.every(isGraphQLSingularResponse)
    : isGraphQLSingularResponse(response);
}

function createInvalidGraphQLResponseError(): TypeError {
  return new TypeError(
    "Failed to fetch GraphQL response from server function",
  );
}

// Auto-retry budget for client-side queries when the browser can't reach
// `/_server`. Tuned for the common "phone briefly off network" case the
// retry is meant to absorb: at 3 attempts the worst case is ~6s of waiting
// before surfacing the error, which is well under the user's patience and
// short enough that a real outage doesn't multiply load by much.
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_BACKOFF_FACTOR = 3;
const RETRY_JITTER_RATIO = 0.3;

function computeRetryDelayMs(attempt: number): number {
  const base = RETRY_BASE_DELAY_MS *
    Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1);
  return base + Math.random() * RETRY_JITTER_RATIO * base;
}

function createRelayEnvironment(): IEnvironment {
  const network = Network.create((params, variables, cacheConfig) =>
    Observable.create<GraphQLResponse>((sink) => {
      addRelayRequestBreadcrumb(params, cacheConfig);

      // Auto-retry transient client-side fetch failures only. SSR runs the
      // fetch in-process to the GraphQL service, so retrying there would
      // hide real upstream problems and slow down page renders. Mutations
      // are not safe to retry blindly (the server may have already applied
      // the write), and subscriptions reconnect through their own channel.
      const canRetry = !isServer && params.operationKind === "query";

      let attempt = 0;
      let currentController: AbortController | null = null;
      let currentSubscription: { unsubscribe: () => void } | null = null;
      let pendingTimer: ReturnType<typeof setTimeout> | null = null;
      let onlineListener: (() => void) | null = null;
      let disposed = false;

      const clearPendingTimer = () => {
        if (pendingTimer != null) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
      };

      const clearOnlineListener = () => {
        if (onlineListener != null) {
          window.removeEventListener("online", onlineListener);
          onlineListener = null;
        }
      };

      const abortCurrent = () => {
        currentController?.abort();
        currentController = null;
        currentSubscription?.unsubscribe();
        currentSubscription = null;
      };

      const scheduleRetry = (error: Error) => {
        Sentry.addBreadcrumb({
          category: "relay.retry",
          level: "info",
          message: `${params.operationKind} ${params.name} retry ${attempt}`,
          data: {
            operation: params.name,
            attempt,
            reason: error.message,
          },
        });
        // The timer is always armed so a single retry is bounded by the
        // backoff, never by network availability — `navigator.onLine`
        // returning `false` short-circuits the wait when the browser
        // notices the link came back, but if it doesn't (or stays off)
        // the timer still fires and the retry budget keeps us from
        // hanging the sink indefinitely. The `fired` latch makes both
        // paths idempotent so a late `online` event cannot double-fire
        // the next attempt after the timer has already done so.
        let fired = false;
        const fireRetry = () => {
          if (fired) return;
          fired = true;
          clearPendingTimer();
          clearOnlineListener();
          attemptOnce();
        };
        pendingTimer = setTimeout(fireRetry, computeRetryDelayMs(attempt));
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          onlineListener = fireRetry;
          window.addEventListener("online", fireRetry);
        }
      };

      const attemptOnce = () => {
        if (disposed) return;
        attempt += 1;
        const controller = new AbortController();
        currentController = controller;
        // SSR runs `fetchFn` in-process; the server-side `try/catch` already
        // propagates the inbound request's signal to the upstream fetch, so
        // the client-side controller is only meaningful in the browser.
        const callable: FetchFunction = isServer
          ? fetchFn
          : (fetchFn as ClientFetchFn).withOptions({
            signal: controller.signal,
          });
        const handleAttemptError = (error: Error) => {
          // Treat aborts as a normal completion: the subscriber is
          // gone, and we don't want a toast or a Sentry capture for a
          // deliberate user-initiated cancellation.
          if (controller.signal.aborted) {
            sink.complete();
            return;
          }
          if (
            canRetry && attempt < MAX_RETRY_ATTEMPTS &&
            isNetworkError(error)
          ) {
            // Drop the failed attempt before scheduling the next one so
            // its controller/subscription don't outlive their usefulness.
            abortCurrent();
            scheduleRetry(error);
            return;
          }
          sink.error(error);
        };
        // `FetchFunction` may return a Promise *or* a Subscribable. Route
        // both through `Observable.from` so the inner subscription's
        // `next`/`complete`/`error` are forwarded faithfully and we can
        // unsubscribe it from cleanup.
        currentSubscription = Observable
          .from(callable(params, variables, cacheConfig))
          .subscribe({
            next: (response) => {
              if (!isGraphQLResponse(response)) {
                handleAttemptError(createInvalidGraphQLResponseError());
                return;
              }
              sink.next(response);
            },
            complete: () => {
              // Null out the controller and subscription before calling
              // sink.complete() so that the synchronous cleanup Relay runs
              // inside sink.complete() does not call abort() on a request
              // that already finished. SolidStart's withOptions proxy
              // registers an abort-event listener that rejects an internal
              // Promise; if abort() fires after the fetch resolved, that
              // Promise rejects with no handler → unhandled AbortError.
              currentController = null;
              currentSubscription = null;
              sink.complete();
            },
            error: handleAttemptError,
          });
      };

      attemptOnce();

      return () => {
        disposed = true;
        clearPendingTimer();
        clearOnlineListener();
        abortCurrent();
      };
    })
  );
  const store = new Store(new RecordSource());
  return new Environment({ store, network });
}

function getRequestEnvironment(): IEnvironment | undefined {
  const event = getRequestEvent();
  if (event?.locals == null) return undefined;

  const locals = event.locals as Record<PropertyKey, unknown>;
  const cached = locals[requestEnvironmentKey];
  if (cached != null) return cached as IEnvironment;

  const environment = createRelayEnvironment();
  locals[requestEnvironmentKey] = environment;
  return environment;
}

export function createEnvironment(): IEnvironment {
  if (isServer) return getRequestEnvironment() ?? createRelayEnvironment();
  return clientEnvironment ??= createRelayEnvironment();
}
