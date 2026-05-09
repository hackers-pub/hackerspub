import { type Uuid, validateUuid } from "@hackerspub/models/uuid";

const SESSION_COOKIE = "session";

// Pulls the `session` cookie out of a Cookie header and returns it only if
// the value decodes cleanly and matches the UUID shape we expect for session
// IDs. Anything else (missing, empty, percent-decode failure, malformed)
// resolves to null so callers can treat the request as anonymous instead of
// passing junk through as a bearer token.
export function parseSessionCookie(
  cookieHeader: string | null | undefined,
): Uuid | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const raw = part.slice(eq + 1).trim();
    if (raw === "") return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    return validateUuid(decoded) ? decoded : null;
  }
  return null;
}

export function readSessionCookie(
  request: Request | undefined,
): Uuid | null {
  return parseSessionCookie(request?.headers.get("cookie"));
}
