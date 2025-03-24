import { and, eq, or } from "drizzle-orm";
import { db } from "../../db.ts";
import { unfollow } from "../../models/following.ts";
import { accountTable, actorTable } from "../../models/schema.ts";
import { define } from "../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (ctx.state.session == null || ctx.state.account == null) {
      return ctx.next();
    }
    const handle = ctx.params.username;
    if (handle.includes("@")) {
      const [username, host] = handle.split("@");
      const followee = await db.query.actorTable.findFirst({
        where: and(
          eq(actorTable.username, username),
          or(
            eq(actorTable.instanceHost, host),
            eq(actorTable.handleHost, host),
          ),
        ),
      });
      if (followee == null) return ctx.next();
      await unfollow(db, ctx.state.fedCtx, ctx.state.account, followee);
    } else {
      const followee = await db.query.accountTable.findFirst({
        with: { actor: true },
        where: eq(accountTable.username, handle),
      });
      if (followee == null || followee.id === ctx.state.session.accountId) {
        return ctx.next();
      }
      await unfollow(db, ctx.state.fedCtx, ctx.state.account, followee.actor);
    }
    return ctx.redirect(`/@${handle}`);
  },
});
