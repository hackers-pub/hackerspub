import { getCookies } from "@std/http/cookie";
import { eq, sql } from "drizzle-orm";
import { federation } from "../federation/federation.ts";
import { db } from "../db.ts";
import { kv } from "../kv.ts";
import { getSession } from "../models/session.ts";
import { define } from "../utils.ts";
import { accountTable } from "../models/schema.ts";
import { validateUuid } from "../models/uuid.ts";

export const handler = define.middleware([
  (ctx) => {
    ctx.state.fedCtx = federation.createContext(ctx.req, undefined);
    return ctx.next();
  },
  (ctx) => {
    ctx.state.title = "Hackers' Pub";
    ctx.state.metas ??= [];
    ctx.state.links ??= [];
    return ctx.next();
  },
  async (ctx) => {
    const cookies = getCookies(ctx.req.headers);
    if (validateUuid(cookies.session)) {
      const session = await getSession(kv, cookies.session);
      if (session != null) {
        const rows = await db.select({ v: sql<number>`1` })
          .from(accountTable)
          .where(eq(accountTable.id, session?.accountId))
          .limit(1);
        ctx.state.session = rows.length > 0 ? session : undefined;
      }
    }
    return await ctx.next();
  },
]);
