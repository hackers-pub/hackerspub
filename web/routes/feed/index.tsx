import { define } from "../../utils.ts";

// /feed only exists on web-next. Anyone routed here through the legacy
// stack (e.g. after opting into the old UI) gets bounced back home.
export const handler = define.handlers({
  GET(ctx) {
    return Response.redirect(new URL("/", ctx.url), 302);
  },
});
