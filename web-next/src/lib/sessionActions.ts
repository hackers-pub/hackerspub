import type { Uuid } from "@hackerspub/models/uuid";
import { appendHeader } from "@solidjs/start/http";
import { getRequestEvent } from "solid-js/web";
import { getBehindProxy } from "./env.ts";
import {
  buildExpiredSessionSetCookieHeader,
  isSecureRequest,
  readSessionCookie,
} from "./sessionCookie.ts";

export async function getCurrentSessionId(): Promise<Uuid | null> {
  "use server";
  const event = getRequestEvent();
  return readSessionCookie(event?.request);
}

export async function removeSessionCookie(): Promise<void> {
  "use server";
  const event = getRequestEvent();
  if (event == null) return;
  appendHeader(
    "Set-Cookie",
    buildExpiredSessionSetCookieHeader({
      secure: isSecureRequest(event.request, getBehindProxy()),
    }),
  );
}
