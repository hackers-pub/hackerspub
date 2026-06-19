import { EXPIRATION } from "@hackerspub/models/session";
import { validateUuid } from "@hackerspub/models/uuid";
import type { APIEvent } from "@solidjs/start/server";
import { buildSessionSetCookieHeader } from "~/lib/sessionCookie.ts";

// Sets the session cookie server-side and returns 204.
// The session ID is sent in the POST body to avoid it appearing in
// browser history, server access logs, and Referer headers.
//
// Note: setCookie(nativeEvent, ...) from @solidjs/start/http is intentionally
// NOT used here. In @solidjs/start 2.0.0-alpha.2, that function produces a
// malformed Set-Cookie header in both "use server" RPCs and POST API route
// handlers — the cookie name becomes "[METHOD] URL" instead of the intended
// name. The workaround is to set the Set-Cookie header directly on the
// Response object, bypassing the nativeEvent entirely.
export async function POST({ request }: APIEvent) {
  const body = await request.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  const id = typeof body?.id === "string" ? body.id : null;
  if (id == null || !validateUuid(id)) {
    return new Response(null, { status: 400 });
  }
  const secure = new URL(request.url).protocol === "https:";
  const expires = new Date(Date.now() + EXPIRATION.total("millisecond"));
  const cookie = buildSessionSetCookieHeader(id, { expires, secure });
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": cookie },
  });
}
