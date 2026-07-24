import { type Uuid, validateUuid } from "@hackerspub/models/uuid";

const SESSION_COOKIE = "session";
const EXPIRED_SESSION_COOKIE_DATE = new Date(0);

interface SessionCookieHeaderOptions {
  expires?: Date;
  maxAge?: number;
  secure: boolean;
}

function buildSessionCookieHeader(
  value: string,
  options: SessionCookieHeaderOptions,
): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "Path=/",
    ...(options.expires == null
      ? []
      : [`Expires=${options.expires.toUTCString()}`]),
    ...(options.maxAge == null ? [] : [`Max-Age=${options.maxAge}`]),
    "SameSite=Lax",
    ...(options.secure ? ["Secure"] : []),
  ];
  return attributes.join("; ");
}

export function buildSessionSetCookieHeader(
  sessionId: Uuid,
  options: { expires: Date; secure: boolean },
): string {
  return buildSessionCookieHeader(sessionId, options);
}

export function buildExpiredSessionSetCookieHeader(options: {
  secure: boolean;
}): string {
  return buildSessionCookieHeader("", {
    expires: EXPIRED_SESSION_COOKIE_DATE,
    maxAge: 0,
    secure: options.secure,
  });
}

export function isSecureRequest(
  request: Request,
  behindProxy: boolean,
): boolean {
  if (!behindProxy) return new URL(request.url).protocol === "https:";

  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",", 1)[0]
    ?.trim()
    .toLowerCase();
  if (forwardedProto) return forwardedProto === "https";

  const forwarded = request.headers.get("forwarded");
  const forwardedProtocol = forwarded
    ?.match(/(?:^|[;,]\s*)proto=([^;,]+)/i)?.[1]
    ?.replace(/^"|"$/g, "")
    .toLowerCase();
  if (forwardedProtocol) return forwardedProtocol === "https";

  return new URL(request.url).protocol === "https:";
}

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

export function readSessionCookie(request: Request | undefined): Uuid | null {
  return parseSessionCookie(request?.headers.get("cookie"));
}
