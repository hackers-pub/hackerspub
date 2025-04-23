import { getArticleSource } from "@hackerspub/models/article";
import { deletePost } from "@hackerspub/models/post";
import { db } from "../../../../db.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers({
  async POST(ctx) {
    if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const year = parseInt(ctx.params.idOrYear);
    const article = await getArticleSource(
      db,
      ctx.params.username,
      year,
      ctx.params.slug,
      ctx.state.account,
    );
    if (article == null || article.accountId !== ctx.state.account?.id) {
      return ctx.next();
    }
    await deletePost(ctx.state.fedCtx, article.post);
    return ctx.redirect(`/@${article.account.username}`, 303);
  },
});
