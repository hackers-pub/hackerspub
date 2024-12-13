import { and, eq, inArray } from "drizzle-orm";
import { page } from "fresh";
import { define } from "../../../utils.ts";
import { db } from "../../../db.ts";
import { kv } from "../../../kv.ts";
import { syncPostFromArticleSource } from "../../../models/post.ts";
import {
  type Account,
  accountTable,
  type ArticleSource,
  articleSourceTable,
} from "../../../models/schema.ts";
import { renderMarkup } from "../../../models/markup.ts";
import { getAvatarUrl } from "../../../models/account.ts";
import { ArticleMetadata } from "../../../components/ArticleMetadata.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const year = parseInt(ctx.params.idOrYear);
    const article = await db.query.articleSourceTable.findFirst({
      with: {
        account: {
          with: { emails: true, links: true },
        },
        post: true,
      },
      where: and(
        eq(
          articleSourceTable.slug,
          ctx.params.slug,
        ),
        eq(articleSourceTable.publishedYear, year),
        inArray(
          articleSourceTable.accountId,
          db.select({ id: accountTable.id })
            .from(accountTable)
            .where(eq(accountTable.username, ctx.params.username)),
        ),
      ),
    });
    if (article == null) return ctx.next();
    if (article.post == null) {
      article.post = await syncPostFromArticleSource(
        db,
        kv,
        ctx.state.fedCtx,
        article,
      );
    }
    return page<ArticlePageProps>({
      article,
      avatarUrl: await getAvatarUrl(article.account),
      contentHtml: (await renderMarkup(article.id, article.content)).html,
    });
  },
});

interface ArticlePageProps {
  article: ArticleSource & { account: Account };
  avatarUrl: string;
  contentHtml: string;
}

export default define.page<typeof handler, ArticlePageProps>(
  function ArticlePage({ url, data: { article, avatarUrl, contentHtml } }) {
    return (
      <article>
        <h1 class="text-4xl font-bold">{article.title}</h1>
        <ArticleMetadata
          class="mt-4"
          authorUrl={`/@${article.account.username}`}
          authorName={article.account.name}
          authorHandle={`@${article.account.username}@${url.host}`}
          authorAvatarUrl={avatarUrl}
          published={article.published}
        />
        <div
          class="prose dark:prose-invert mt-4 text-xl"
          dangerouslySetInnerHTML={{ __html: contentHtml }}
        />
      </article>
    );
  },
);
