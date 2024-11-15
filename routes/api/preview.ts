import { define } from "../../utils.ts";
import { renderMarkup } from "../../models/markup.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (ctx.state.session == null) return ctx.next();
    const markup = await ctx.req.text();
    const rendered = await renderMarkup("", markup);
    return new Response(rendered.html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});
