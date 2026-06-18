import assert from "node:assert";
import test from "node:test";
import type { Uuid } from "@hackerspub/models/uuid";
import {
  buildExpiredSessionSetCookieHeader,
  buildSessionSetCookieHeader,
  parseSessionCookie,
} from "./sessionCookie.ts";

const SESSION_ID = "019f0c7f-8c99-7000-8000-000000000001" as Uuid;

test("buildSessionSetCookieHeader serializes a session cookie", () => {
  const cookie = buildSessionSetCookieHeader(SESSION_ID, {
    expires: new Date("2026-06-18T12:00:00.000Z"),
    secure: true,
  });

  assert.deepEqual(
    cookie,
    "session=019f0c7f-8c99-7000-8000-000000000001; HttpOnly; Path=/; " +
      "Expires=Thu, 18 Jun 2026 12:00:00 GMT; SameSite=Lax; Secure",
  );
});

test("buildExpiredSessionSetCookieHeader expires the session cookie", () => {
  const cookie = buildExpiredSessionSetCookieHeader({ secure: false });

  assert.deepEqual(
    cookie,
    "session=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; " +
      "Max-Age=0; SameSite=Lax",
  );
});

test("buildExpiredSessionSetCookieHeader preserves Secure when required", () => {
  const cookie = buildExpiredSessionSetCookieHeader({ secure: true });

  assert.ok(cookie.endsWith("; Secure"));
});

test("parseSessionCookie reads valid session cookies", () => {
  const sessionId = parseSessionCookie(`theme=dark; session=${SESSION_ID}`);

  assert.deepEqual(sessionId, SESSION_ID);
});
