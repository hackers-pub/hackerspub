import { setUser } from "@sentry/deno";
import { getCookies } from "@std/http/cookie";
import { eq } from "drizzle-orm";
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
        const account = await db.query.accountTable.findFirst({
          where: eq(accountTable.id, session.accountId),
          with: { actor: true, emails: true },
        });
        ctx.state.account = account;
        ctx.state.session = account == null ? undefined : session;
        if (account != null) {
          setUser({
            id: account.id,
            username: account.username,
            email: account.emails[0]?.email,
            ip_address: ctx.info.remoteAddr.transport === "tcp"
              ? ctx.info.remoteAddr.hostname
              : undefined,
          });
        }
      }
    }
    if (ctx.state.account == null) {
      setUser({
        ip_address: ctx.info.remoteAddr.transport === "tcp"
          ? ctx.info.remoteAddr.hostname
          : undefined,
      });
    }
    try {
      return await ctx.next();
    } finally {
      setUser(null);
    }
  },
]);
