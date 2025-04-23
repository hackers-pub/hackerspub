import { getArticleSource } from "@hackerspub/models/article";
import { isReactionEmoji } from "@hackerspub/models/emoji";
import { isPostVisibleTo } from "@hackerspub/models/post";
import { react, undoReaction } from "@hackerspub/models/reaction";
import type { Reaction } from "@hackerspub/models/schema";
import { db } from "../../../../db.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const username = ctx.params.username;
    const year = parseInt(ctx.params.idOrYear);
    const slug = ctx.params.slug;
    const article = await getArticleSource(
      db,
      username,
      year,
      slug,
      ctx.state.account,
    );
    if (article == null) return ctx.next();
    const post = article.post;
    if (!isPostVisibleTo(post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    if (ctx.state.account == null) {
      return new Response("Forbidden", { status: 403 });
    }
    const { emoji, mode } = await ctx.req.json();
    if (!isReactionEmoji(emoji)) {
      return new Response("Bad Request", { status: 400 });
    }
    let reaction: Reaction | undefined;
    if (mode === "undo") {
      reaction = await undoReaction(
        ctx.state.fedCtx,
        ctx.state.account,
        post,
        emoji,
      );
    } else {
      reaction = await react(
        ctx.state.fedCtx,
        ctx.state.account,
        post,
        emoji,
      );
    }
    if (reaction == null) return new Response("Bad Request", { status: 400 });
    return new Response(JSON.stringify(reaction), {
      headers: {
        "Content-Type": "application/json",
      },
    });
  },
});
