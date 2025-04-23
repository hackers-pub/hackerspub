import { unfollow } from "@hackerspub/models/following";
import { db } from "../../db.ts";
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
        where: {
          username,
          OR: [
            { instanceHost: host },
            { handleHost: host },
          ],
        },
      });
      if (followee == null) return ctx.next();
      await unfollow(ctx.state.fedCtx, ctx.state.account, followee);
    } else {
      const followee = await db.query.accountTable.findFirst({
        with: { actor: true },
        where: { username: handle },
      });
      if (followee == null || followee.id === ctx.state.session.accountId) {
        return ctx.next();
      }
      await unfollow(ctx.state.fedCtx, ctx.state.account, followee.actor);
    }
    const form = await ctx.req.formData();
    const returnUrl = form.get("return")?.toString();
    return ctx.redirect(returnUrl == null ? `/@${handle}` : returnUrl);
  },
});
