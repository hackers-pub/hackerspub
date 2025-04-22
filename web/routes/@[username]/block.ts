import { block } from "@hackerspub/models/blocking";
import type { Actor } from "@hackerspub/models/schema";
import { db } from "../../db.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    let actor: Actor | undefined;
    if (ctx.params.username.includes("@")) {
      const names = ctx.params.username.split("@");
      if (names.length !== 2) return ctx.next();
      const [username, host] = names;
      actor = await db.query.actorTable.findFirst({
        where: {
          username,
          OR: [
            { instanceHost: host },
            { handleHost: host },
          ],
        },
      });
    } else {
      const account = await db.query.accountTable.findFirst({
        with: { actor: true },
        where: { username: ctx.params.username },
      });
      actor = account?.actor;
    }
    if (actor == null) return ctx.next();
    if (ctx.state.account == null || ctx.state.account.actor.id === actor.id) {
      return new Response("Forbidden", { status: 403 });
    }
    await block(db, ctx.state.fedCtx, ctx.state.account, actor);
    return ctx.redirect(`/@${ctx.params.username}`, 303);
  },
});
