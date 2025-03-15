import { and, eq, ilike } from "drizzle-orm";
import { db } from "../../db.ts";
import { type Actor, actorTable } from "../../models/schema.ts";
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
    const result: Actor[] = await db.query.actorTable.findMany({
      where: host == null || !URL.canParse(`http://${host}`)
        ? ilike(
          actorTable.username,
          `${username}%`,
        )
        : and(
          eq(actorTable.username, username),
          ilike(
            actorTable.instanceHost,
            `${new URL(`http://${host}`).host}%`,
          ),
        ),
      orderBy: [actorTable.username, actorTable.instanceHost],
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
