import { getCookies } from "@std/http/cookie";
import { define } from "../utils.ts";
import { getSession } from "../models/session.ts";
import { kv } from "../kv.ts";

export const handler = define.middleware(async (ctx) => {
  const cookies = getCookies(ctx.req.headers);
  if (cookies.session != null) {
    ctx.state.session = await getSession(kv, cookies.session);
  }
  return await ctx.next();
});
