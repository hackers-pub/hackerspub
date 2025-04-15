import { db } from "../../db.ts";
import { drive } from "../../drive.ts";
import { renderMarkup } from "../../models/markup.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const nonce = ctx.req.headers.get("Echo-Nonce");
    const markup = await ctx.req.text();
    const disk = drive.use();
    const rendered = await renderMarkup(db, disk, ctx.state.fedCtx, markup);
    if (ctx.req.headers.get("Accept") === "application/json") {
      return new Response(JSON.stringify(rendered), {
        headers: {
          "Access-Control-Expose-Headers": "Echo-Nonce",
          "Content-Type": "application/json; charset=utf-8",
          ...(nonce == null ? {} : { "Echo-Nonce": nonce }),
        },
      });
    }
    return new Response(rendered.html, {
      headers: {
        "Access-Control-Expose-Headers": "Echo-Nonce",
        "Content-Type": "text/html; charset=utf-8",
        ...(nonce == null ? {} : { "Echo-Nonce": nonce }),
      },
    });
  },
});
