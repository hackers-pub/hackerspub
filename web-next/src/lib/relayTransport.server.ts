import * as Sentry from "@sentry/solidstart";
import type { FetchFunction, GraphQLResponse } from "relay-runtime";
import { getRequestEvent } from "solid-js/web";
import { getApiUrl, getBehindProxy } from "./env.ts";
import {
  GraphQLRequestCancelledError,
  isGraphQLRequestCancelledError,
} from "./graphQLCancellation.ts";
import { createGraphQLRequestLifetime } from "./graphQLRequestLifetime.ts";
import {
  getInteractiveGraphQLTimeout,
  getSsrGraphQLPolicy,
} from "./graphQLTransportPolicy.ts";
import { isExpectedAuthError } from "./graphqlAuthError.ts";
import { readSessionCookie } from "./sessionCookie.ts";
import { getSsrGraphQLDeadline } from "./ssrGraphQLBudget.ts";
import { createUpstreamRequestInit } from "./upstreamRequest.ts";
import {
  shouldCaptureUpstreamError,
  TransientUpstreamGraphQLError,
} from "./upstreamGraphQLError.ts";

const UPSTREAM_BODY_PREVIEW_LENGTH = 2048;

function isSensitiveResponseHeader(name: string): boolean {
  const headerName = name.toLowerCase();
  return (
    headerName.includes("cookie") ||
    headerName.includes("authorization") ||
    headerName.includes("token") ||
    headerName.includes("secret") ||
    headerName.includes("key")
  );
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

// Report an upstream GraphQL failure to the console and Sentry with the HTTP
// status, operation, and a (redacted) response diagnostic, returning the
// `Error` the caller should throw or attach. Used both for non-OK JSON
// responses (where Relay still receives the `errors` payload, so we report
// but don't throw) and for non-OK responses whose body isn't even JSON (e.g.
// a Caddy 504 Gateway Timeout with an empty body), where there's nothing to
// return and the caller throws this instead of a raw `SyntaxError`.
function reportUpstreamError(args: {
  params: Parameters<FetchFunction>[0];
  variables: Parameters<FetchFunction>[1];
  response: Response;
  responseText?: string;
  errors?: ReadonlyArray<unknown>;
  userIdentity?: { id: string };
}): Error {
  const { params, variables, response, responseText, errors, userIdentity } =
    args;
  const summary = `GraphQL upstream error: ${params.name ?? "<unnamed>"}`;
  // Keep request `variables` out of stdout: for auth mutations they can carry
  // replayable sign-in tokens / codes, and server logs are routinely shipped
  // to aggregators. The operation, status, and any GraphQL `errors` are enough
  // to triage from logs; the full variables still go to Sentry below, which is
  // access-controlled.
  console.error("[RelayNetwork upstream error]", {
    operation: params.name,
    operationKind: params.operationKind,
    query: params.text,
    status: response.status,
    statusText: response.statusText,
    errors,
  });
  const shouldCapture = shouldCaptureUpstreamError({
    status: response.status,
    responseText,
    errors,
  });
  const error = shouldCapture
    ? new Error(summary)
    : new TransientUpstreamGraphQLError(params.name, response.status);
  if (shouldCapture) {
    Sentry.captureException(error, {
      extra: {
        operation: params.name,
        operationKind: params.operationKind,
        query: params.text,
        variables,
        status: response.status,
        statusText: response.statusText,
        upstreamResponse: getUpstreamResponseDiagnostics(
          response,
          responseText,
        ),
        errors,
      },
      ...(userIdentity == null ? {} : { user: userIdentity }),
    });
  }
  return error;
}

type GraphQLParams = Parameters<FetchFunction>[0];
type GraphQLVariables = Parameters<FetchFunction>[1];

async function fetchGraphQL(
  params: GraphQLParams,
  variables: GraphQLVariables,
  policy: "ssr" | "interactive",
  operationSignal?: AbortSignal,
): Promise<GraphQLResponse> {
  if (!params.text) throw new Error("Operation document must be provided");
  const event = getRequestEvent();
  const started = performance.now();
  let deadline: number;
  let timeoutMessage: string;
  if (policy === "ssr") {
    const { timeoutMs, budgetMs } = getSsrGraphQLPolicy();
    const pageDeadline =
      event?.locals == null
        ? Infinity
        : getSsrGraphQLDeadline(event.locals, budgetMs);
    deadline = Math.min(started + timeoutMs, pageDeadline);
    timeoutMessage =
      pageDeadline <= started + timeoutMs
        ? `SSR GraphQL page budget of ${budgetMs} ms exceeded`
        : `SSR GraphQL operation deadline of ${timeoutMs} ms exceeded`;
  } else {
    const timeoutMs = getInteractiveGraphQLTimeout();
    deadline = started + timeoutMs;
    timeoutMessage = `Interactive GraphQL operation deadline of ${timeoutMs} ms exceeded`;
  }
  const lifetime = createGraphQLRequestLifetime({
    deadline,
    timeoutMessage,
    requestSignal: event?.request.signal,
    operationSignal,
  });
  let response: Response | undefined;
  let responseText: string | undefined;
  let userIdentity: { id: string } | undefined;
  let reported = false;
  try {
    lifetime.check();
    const sessionId = readSessionCookie(event?.request);
    // Scope identity to this capture, including preload failures before the
    // layout has rendered, without sharing credentials between requests.
    userIdentity =
      sessionId == null
        ? undefined
        : { id: await fingerprintSessionId(sessionId) };
    lifetime.check();
    response = await fetch(
      getApiUrl(),
      createUpstreamRequestInit({
        request: event?.request,
        sessionId,
        behindProxy: getBehindProxy(),
        body: JSON.stringify({ query: params.text, variables }),
        signal: lifetime.signal,
      }),
    );
    lifetime.check();
    responseText = await response.text();
    lifetime.check();
    let body: GraphQLResponse;
    try {
      body = JSON.parse(responseText) as GraphQLResponse;
    } catch (cause) {
      // Invalid non-OK bodies (including empty gateway failures) describe an
      // HTTP error; a malformed successful response remains a JSON error.
      if (!response.ok) {
        reported = true;
        throw reportUpstreamError({
          params,
          variables,
          response,
          responseText,
          userIdentity,
        });
      }
      throw cause;
    }
    lifetime.check();
    const errors = "errors" in body ? body.errors : undefined;
    if (!response.ok || errors != null) {
      if (!(response.ok && errors != null && isExpectedAuthError(errors))) {
        reportUpstreamError({
          params,
          variables,
          response,
          errors,
          userIdentity,
        });
      }
    }
    lifetime.check();
    return body;
  } catch (cause) {
    const error = lifetime.normalizeError(cause);
    if (!reported && !isGraphQLRequestCancelledError(error)) {
      Sentry.captureException(error, {
        extra: {
          operation: params.name,
          operationKind: params.operationKind,
          query: params.text,
          variables,
          ...(response == null
            ? {}
            : {
                upstreamResponse: getUpstreamResponseDiagnostics(
                  response,
                  responseText,
                ),
              }),
        },
        ...(userIdentity == null ? {} : { user: userIdentity }),
      });
    }
    throw error;
  } finally {
    lifetime.dispose();
  }
}

/** In-process SSR entry: the attempt signal never crosses serialization. */
export function fetchSsrGraphQL(
  params: GraphQLParams,
  variables: GraphQLVariables,
  operationSignal: AbortSignal,
): Promise<GraphQLResponse> {
  return fetchGraphQL(params, variables, "ssr", operationSignal);
}

/** RPC entry: interactive queries and mutations retain their longer policy. */
export async function fetchInteractiveGraphQL(
  params: GraphQLParams,
  variables: GraphQLVariables,
): Promise<GraphQLResponse> {
  try {
    return await fetchGraphQL(params, variables, "interactive");
  } catch (error) {
    if (error instanceof GraphQLRequestCancelledError) {
      // The original inbound reason belongs to this server, and may carry
      // native/nonserializable state. Only the safe error crosses RPC.
      throw new GraphQLRequestCancelledError(error.source);
    }
    throw error;
  }
}
