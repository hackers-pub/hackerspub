import { redirect } from "@solidjs/router";
import { createMiddleware } from "@solidjs/start/middleware";
import { hasMalformedPathEncoding } from "~/lib/requestPath.ts";
import { readSessionCookie } from "~/lib/sessionCookie.ts";

export default createMiddleware({
  onRequest(event) {
    const url = new URL(event.request.url);
    if (hasMalformedPathEncoding(url.pathname)) {
      return new Response("Bad Request", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=UTF-8" },
      });
    }
    if (url.pathname !== "/") return;

    const target = readSessionCookie(event.request) == null
      ? "/local"
      : "/feed";
    return redirect(`${target}${url.search}`);
  },
});
