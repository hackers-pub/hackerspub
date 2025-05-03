import { page } from "@fresh/core";
import {
  getArticleSource,
  getOriginalArticleContent,
  startArticleContentTranslation,
} from "@hackerspub/models/article";
import { normalizeLocale } from "@hackerspub/models/i18n";
import { isPostVisibleTo } from "@hackerspub/models/post";
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
    const lang = normalizeLocale(ctx.params.lang);
    if (lang == null) return ctx.next();
    const original = getOriginalArticleContent(article);
    if (original?.language === lang) {
      return ctx.redirect(
        new URL(
          `/@${article.account.username}/${article.publishedYear}/${article.slug}`,
          ctx.state.canonicalOrigin,
        ).href,
      );
    }
    let content = article.contents.find((c) =>
      c.language.toLowerCase() === lang
    );
    if (
      content == null ||
      content.beingTranslated &&
        content.updated.getTime() < Date.now() - 30 * 60 * 1000
    ) {
      if (ctx.state.account == null || !article.allowLlmTranslation) {
        return ctx.next();
      }
      const original = getOriginalArticleContent(article);
      if (original == null) return ctx.next();
      content = await startArticleContentTranslation(
        ctx.state.fedCtx,
        {
          content: original,
          targetLanguage: lang,
          requester: ctx.state.account,
        },
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
        ...(content.beingTranslated
          ? {
            Refresh: "30",
          }
          : {}),
      },
    });
  },
});

export default define.page<typeof handler, ArticlePageProps>(
  ({ data }) => <ArticlePage {...data} />,
);
