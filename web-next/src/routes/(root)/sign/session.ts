import { EXPIRATION } from "@hackerspub/models/session";
import { validateUuid } from "@hackerspub/models/uuid";
import { getRequestProtocol, setCookie } from "@solidjs/start/http";
import type { APIEvent } from "@solidjs/start/server";

// Sets the session cookie server-side and returns 200.
// This exists because setCookie() inside an inline "use server" function
// produces a malformed Set-Cookie header in production builds when the
// function is called as an RPC from the client (/_server endpoint).
// The session ID is sent in the POST body to avoid it appearing in
// browser history, server access logs, and Referer headers.
export async function POST({ nativeEvent, request }: APIEvent) {
  const body = await request.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  const id = typeof body?.id === "string" ? body.id : null;
  if (id == null || !validateUuid(id)) {
    return new Response(null, { status: 400 });
  }
  setCookie(nativeEvent, "session", id, {
    httpOnly: true,
    path: "/",
    expires: new Date(Date.now() + EXPIRATION.total("millisecond")),
    secure: getRequestProtocol(nativeEvent) === "https",
  });
  return new Response(null, { status: 204 });
}
