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

const fetchFn: FetchFunction = async (
  params,
  variables,
) => {
  "use server";

  if (!params.text) throw new Error("Operation document must be provided");

  const event = getRequestEvent();
  const sessionId = readSessionCookie(event?.request);

  const response = await fetch(getApiUrl(), {
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

  const body: GraphQLResponse = await response.json();
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
  if (event == null || !("locals" in event)) return undefined;

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
