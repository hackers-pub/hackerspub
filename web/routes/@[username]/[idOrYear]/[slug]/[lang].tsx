import { page } from "@fresh/core";
import {
  getArticleSource,
  getOriginalArticleContent,
} from "../../../../../models/article.ts";
import { isPostVisibleTo } from "../../../../../models/post.ts";
import { db } from "../../../../db.ts";
import { define } from "../../../../utils.ts";
import { ArticlePage, type ArticlePageProps, handleArticle } from "./index.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const year = parseInt(ctx.params.idOrYear);
    const article = await getArticleSource(
      db,
      ctx.params.username,
      year,
      ctx.params.slug,
      ctx.state.account,
    );
    if (article == null) return ctx.next();
    if (!isPostVisibleTo(article.post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const lang = ctx.params.lang.toLowerCase();
    const content = article.contents.find((c) =>
      c.language.toLowerCase() === lang
    );
    if (content == null) return ctx.next();
    const original = getOriginalArticleContent(article);
    if (original?.language === content.language) {
      return ctx.redirect(
        new URL(
          `/@${article.account.username}/${article.publishedYear}/${article.slug}`,
          ctx.state.canonicalOrigin,
        ).href,
      );
    }
    const permalink = new URL(
      `/@${article.account.username}/${article.publishedYear}/${article.slug}/${content.language}`,
      ctx.state.canonicalOrigin,
    );
    const props = await handleArticle(ctx, article, content, permalink);
    return page<ArticlePageProps>(props, {
      headers: {
        Link:
          `<${props.articleIri}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },
});

export default define.page<typeof handler, ArticlePageProps>(
  ({ data }) => <ArticlePage {...data} />,
);
