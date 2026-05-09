import * as Sentry from "@sentry/solidstart";
import type {
  FetchFunction,
  GraphQLResponse,
  IEnvironment,
} from "relay-runtime";
import { Environment, Network, RecordSource, Store } from "relay-runtime";
import { getRequestEvent, isServer } from "solid-js/web";
import { getApiUrl } from "~/lib/env.ts";

function readSessionCookie(request: Request | undefined): string | null {
  const cookieHeader = request?.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== "session") continue;
    const raw = part.slice(eq + 1).trim();
    return raw ? decodeURIComponent(raw) : null;
  }
  return null;
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
    });
    body = await response.json();
  } catch (cause) {
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

function createRelayEnvironment(): IEnvironment {
  const network = Network.create((params, variables, cacheConfig) => {
    return fetchFn(params, variables, cacheConfig);
  });
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
