import type { Uuid } from "@hackerspub/models/uuid";

interface UpstreamRequestOptions {
  readonly request: Request | undefined;
  readonly sessionId: Uuid | null;
  readonly behindProxy: boolean;
  readonly body: BodyInit;
}

export function createUpstreamRequestInit(
  options: UpstreamRequestOptions,
): RequestInit {
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  if (options.sessionId != null) {
    headers.set("Authorization", `Bearer ${options.sessionId}`);
  }
  if (options.behindProxy && options.request != null) {
    for (const name of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
    ]) {
      const value = options.request.headers.get(name);
      if (value != null) headers.set(name, value);
    }
  }
  return {
    method: "POST",
    headers,
    credentials: "include",
    body: options.body,
    signal: options.request?.signal,
  };
}
