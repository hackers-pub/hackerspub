import { db } from "../../../../db.ts";
import { drive } from "../../../../drive.ts";
import { kv } from "../../../../kv.ts";
import { getArticleSource } from "../../../../models/article.ts";
import { isPostVisibleTo, unsharePost } from "../../../../models/post.ts";
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
    const unshared = await unsharePost(
      db,
      kv,
      drive.use(),
      ctx.state.fedCtx,
      ctx.state.account,
      post,
    );
    if (unshared == null) return ctx.next();
    return ctx.redirect(post.url ?? post.iri, 303);
  },
});
