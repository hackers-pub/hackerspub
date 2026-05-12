import { redirect } from "@solidjs/router";
import { createMiddleware } from "@solidjs/start/middleware";
import { readSessionCookie } from "~/lib/sessionCookie.ts";

export default createMiddleware({
  onRequest(event) {
    const url = new URL(event.request.url);
    if (url.pathname !== "/") return;

    const target = readSessionCookie(event.request) == null
      ? "/local"
      : "/feed";
    return redirect(`${target}${url.search}`);
  },
});
