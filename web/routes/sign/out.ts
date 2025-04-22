import { deleteSession } from "@hackerspub/models/session";
import { deleteCookie } from "@std/http/cookie";
import { kv } from "../../kv.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (ctx.state.session != null) {
      await deleteSession(kv, ctx.state.session.id);
    }
    const form = await ctx.req.formData();
    const next = form.get("next")?.toString();
    const headers = new Headers();
    deleteCookie(headers, "session", {
      path: "/",
      secure: ctx.url.protocol === "https:",
    });
    headers.set("location", next ?? "/");
    return new Response(null, { status: 301, headers });
  },
});
