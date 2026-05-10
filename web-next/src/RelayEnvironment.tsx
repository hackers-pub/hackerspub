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
import { readSessionCookie } from "~/lib/sessionCookie.ts";

// Errors the upstream produces in response to an authentication
// failure. The GraphQL server tags these with this extension code (see
// graphql/timeline.ts) precisely so we can recognize them here without
// pattern-matching on the user-facing message. Relay's `PayloadError`
// type does not model `extensions`, but Yoga emits them per the
// GraphQL spec, so we read it through a structural narrowing.
const AUTH_REQUIRED_CODE = "AUTHENTICATION_REQUIRED";

function isExpectedAuthError(errors: ReadonlyArray<unknown>): boolean {
  if (errors.length === 0) return false;
  return errors.every((error) => {
    if (error == null || typeof error !== "object") return false;
    const extensions = (error as { extensions?: unknown }).extensions;
    if (extensions == null || typeof extensions !== "object") return false;
    return (extensions as { code?: unknown }).code === AUTH_REQUIRED_CODE;
  });
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
    body = await response.json();
  } catch (cause) {
    // The client unsubscribed (e.g. the user clicked Cancel on alt-text
    // generation) and that closed our inbound request, which in turn
    // aborted the upstream fetch. This is a normal cancellation, not a
    // defect — don't page anyone via Sentry. We narrow on the error name
    // rather than just `upstreamSignal.aborted` so that a real fetch /
    // JSON-parse failure that happens to land while an unrelated abort
    // is in flight still gets captured.
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    // When the signal fires after response headers arrive but while the
    // body is still being read, undici may raise SyntaxError("Unexpected
    // end of JSON input") instead of AbortError because it truncates the
    // in-flight stream mid-parse. That is still a normal cancellation.
    // We check the exact error shape (SyntaxError + the specific truncation
    // message + the signal being aborted) so that a genuinely malformed
    // upstream response racing with a client disconnect still reaches Sentry.
    if (
      cause instanceof SyntaxError &&
      cause.message === "Unexpected end of JSON input" &&
      upstreamSignal?.aborted
    ) throw cause;
    // Upstream unreachable / connection reset / non-JSON body. Relay
    // catches network errors internally and only logs them to the
    // console (see comment below), so without an explicit capture here
    // they wouldn't reach Sentry at all.
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
      errors,
    });
    Sentry.captureException(new Error(summary), {
      extra: {
        operation: params.name,
        operationKind: params.operationKind,
        query: params.text,
        variables,
        status: response.status,
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

function createRelayEnvironment(): IEnvironment {
  const network = Network.create((params, variables, cacheConfig) =>
    Observable.create<GraphQLResponse>((sink) => {
      const controller = new AbortController();
      // SSR runs `fetchFn` in-process; the server-side `try/catch` already
      // propagates the inbound request's signal to the upstream fetch, so
      // the client-side controller is only meaningful in the browser.
      const callable: FetchFunction = isServer
        ? fetchFn
        : (fetchFn as ClientFetchFn).withOptions({
          signal: controller.signal,
        });
      // `FetchFunction` may return a Promise *or* a Subscribable. Route
      // both through `Observable.from` so the inner subscription's
      // `next`/`complete`/`error` are forwarded faithfully and we can
      // unsubscribe it from cleanup.
      const inner = Observable.from(callable(params, variables, cacheConfig))
        .subscribe({
          next: (response) => sink.next(response),
          complete: () => sink.complete(),
          error: (error: Error) => {
            // Treat aborts as a normal completion: the subscriber is
            // gone, and we don't want a toast or a Sentry capture for a
            // deliberate user-initiated cancellation.
            if (controller.signal.aborted) {
              sink.complete();
              return;
            }
            sink.error(error);
          },
        });
      return () => {
        controller.abort();
        inner.unsubscribe();
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
