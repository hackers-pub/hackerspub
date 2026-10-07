import { appendHeader } from "@solidjs/start/http";
import { getRequestEvent } from "solid-js/web";
import {
  createOperationDescriptor,
  getRequest,
  type GraphQLTaggedNode,
  type OperationType,
  type IEnvironment,
} from "relay-runtime";
import { validateUuid } from "@hackerspub/models/uuid";
import { EXPIRATION } from "@hackerspub/models/session";
import { getApiUrl, getBehindProxy } from "./env.ts";
import {
  buildSessionSetCookieHeader,
  isSecureRequest,
  readSessionCookie,
} from "./sessionCookie.ts";
import { createUpstreamRequestInit } from "./upstreamRequest.ts";

async function request(
  query: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  "use server";
  const event = getRequestEvent();
  const response = await fetch(
    getApiUrl(),
    createUpstreamRequestInit({
      request: event?.request,
      sessionId: readSessionCookie(event?.request),
      behindProxy: getBehindProxy(),
      body: JSON.stringify({ query, variables }),
    }),
  );
  // This path intentionally has no diagnostics containing variables or bodies:
  // recovery credentials must never become telemetry or normalized Relay data.
  const body = await response.json();
  if (!response.ok || body.errors != null || body.data == null)
    throw new Error("Account security operation failed.");
  appendHeader("Cache-Control", "no-store");
  const id =
    body.data.enableAccountPasskeyOnly?.session?.id ??
    body.data.loginByRecoveryCode?.session?.id;
  if (validateUuid(id) && event != null) {
    appendHeader(
      "Set-Cookie",
      buildSessionSetCookieHeader(id, {
        secure: isSecureRequest(event.request, getBehindProxy()),
        expires: new Date(Date.now() + EXPIRATION.total("millisecond")),
      }),
    );
  }
  return body.data;
}

/** Fetch without normalizing secret-bearing mutation payloads into Relay. */
export async function runPrivateMutation<T extends OperationType>(
  operation: GraphQLTaggedNode,
  variables: T["variables"],
): Promise<T["response"]> {
  const text = getRequest(operation).params.text;
  if (text == null) throw new Error("Missing operation document.");
  return (await request(text, variables)) as T["response"];
}

/** Normalize only a caller-sanitized payload; secret fields must be removed first. */
export function commitPrivatePayload<T extends OperationType>(
  environment: IEnvironment,
  operation: GraphQLTaggedNode,
  variables: T["variables"],
  data: T["response"],
): void {
  environment.commitPayload(
    createOperationDescriptor(getRequest(operation), variables),
    data as Record<string, unknown>,
  );
}
