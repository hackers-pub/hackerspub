import { fetchInteractiveGraphQL, fetchSsrGraphQL } from "#relay-transport";
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
import { isExpectedAuthResponse } from "~/lib/graphqlAuthError.ts";
import { isNetworkError } from "~/lib/networkError.ts";
import { createRelayResponseObservable } from "~/lib/relayResponse.ts";

const fetchFn: FetchFunction = async (params, variables) => {
  "use server";

  return fetchInteractiveGraphQL(params, variables);
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
  return (
    "errors" in response &&
    Array.isArray(response.errors) &&
    response.errors.length > 0
  );
}

function isGraphQLData(data: unknown): boolean {
  return data === null || (typeof data === "object" && !Array.isArray(data));
}

function isGraphQLResponse(response: unknown): response is GraphQLResponse {
  return Array.isArray(response)
    ? response.length > 0 && response.every(isGraphQLSingularResponse)
    : isGraphQLSingularResponse(response);
}

function createInvalidGraphQLResponseError(): TypeError {
  return new TypeError("Failed to fetch GraphQL response from server function");
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
  const base =
    RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1);
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
        // SSR passes the attempt signal directly to the server transport.
        // The RPC wrapper keeps serializable arguments and its longer budget.
        const callable: FetchFunction = isServer
          ? (params, variables) =>
              fetchSsrGraphQL(params, variables, controller.signal)
          : (fetchFn as ClientFetchFn).withOptions({
              signal: controller.signal,
            });
        const handleAttemptError = (error: Error) => {
          // A disposed attempt has no subscriber left to notify.
          if (controller.signal.aborted) return;
          // Inbound SSR cancellation must remain an error: empty completion
          // activates solid-relay's preloaded-query ifEmpty fallback fetch.
          if (
            canRetry &&
            attempt < MAX_RETRY_ATTEMPTS &&
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
        currentSubscription = createRelayResponseObservable(
          callable(params, variables, cacheConfig),
          controller,
        ).subscribe({
          next: (response) => {
            if (!isGraphQLResponse(response)) {
              handleAttemptError(createInvalidGraphQLResponseError());
              return;
            }
            if (!isServer && isExpectedAuthResponse(response)) {
              // The root viewer snapshot can remain authenticated after a
              // session expires. Reload so it is fetched again and the
              // protected route's normal sign-in redirect takes over.
              currentSubscription = null;
              window.location.reload();
              sink.complete();
              return;
            }
            sink.next(response);
          },
          complete: () => {
            // Release completed requests before synchronous Relay cleanup
            // can abort their transport while forwarding completion.
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
    }),
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
  return (clientEnvironment ??= createRelayEnvironment());
}
