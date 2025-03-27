import { eq } from "drizzle-orm";
import { desc } from "drizzle-orm/expressions";
import { db } from "../../db.ts";
import type { Actor } from "../../models/schema.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.account == null) return ctx.next();
    const nonce = ctx.req.headers.get("Echo-Nonce");
    const prefix = (ctx.url.searchParams.get("prefix") ?? "")
      .replace(/^\s*@|\s+$/g, "");
    const [username, host] = prefix.includes("@")
      ? prefix.split("@")
      : [prefix, undefined];
    const canonicalHost = new URL(ctx.state.fedCtx.canonicalOrigin).host;
    const result: Actor[] = await db.query.actorTable.findMany({
      where: {
        ...(host == null || !URL.canParse(`http://${host}`)
          ? { username: { ilike: `${username}%` } }
          : {
            username,
            handleHost: {
              ilike: `${new URL(`http://${host}`).host}%`,
            },
            instanceHost: {
              ilike: `${new URL(`http://${host}`).host}%`,
            },
          }),
        // Exclude the instance actor:
        NOT: {
          username: canonicalHost,
          handleHost: canonicalHost,
        },
      },
      orderBy: (t) => [
        desc(eq(t.username, username)),
        desc(eq(t.handleHost, canonicalHost)),
        t.username,
        t.handleHost,
      ],
      limit: 25,
    });
    return new Response(JSON.stringify(result), {
      headers: {
        "Access-Control-Expose-Headers": "Echo-Nonce",
        "Content-Type": "application/json; charset=utf-8",
        ...(nonce == null ? {} : { "Echo-Nonce": nonce }),
      },
    });
  },
});
