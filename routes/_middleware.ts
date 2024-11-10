import { getCookies } from "@std/http/cookie";
import { federation } from "../federation/federation.ts";
import { kv } from "../kv.ts";
import { getSession } from "../models/session.ts";
import { define } from "../utils.ts";

export const handler = define.middleware([
  (ctx) => {
    ctx.state.fedCtx = federation.createContext(ctx.req, undefined);
    return ctx.next();
  },
  (ctx) => {
    ctx.state.title = "Hackers' Pub";
    ctx.state.links ??= [];
    return ctx.next();
  },
  async (ctx) => {
    const cookies = getCookies(ctx.req.headers);
    if (cookies.session != null) {
      ctx.state.session = await getSession(kv, cookies.session);
    }
    return await ctx.next();
  },
]);
