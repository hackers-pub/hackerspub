import { and, eq, inArray } from "drizzle-orm";
import { page } from "fresh";
import { define } from "../../../utils.ts";
import { db } from "../../../db.ts";
import {
  type Account,
  accountTable,
  type ArticleSource,
  articleSourceTable,
} from "../../../models/schema.ts";
import { renderMarkup } from "../../../models/markup.ts";
import { getAvatarUrl } from "../../../models/account.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (!ctx.params.year.match(/^\d+$/)) return ctx.next();
    const year = parseInt(ctx.params.year);
    const article = await db.query.articleSourceTable.findFirst({
      with: {
        account: {
          with: { emails: true },
        },
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
        <p class="mt-4 text-stone-500">
          <a href={`/@${article.account.username}`}>
            <img
              src={avatarUrl}
              width={18}
              height={18}
              class="inline-block mr-2 align-text-bottom"
            />
            <strong class="text-black dark:text-white">
              {article.account.name}
            </strong>{" "}
            <span class="select-all before:content-['('] after:content-[')']">
              @{article.account.username}@{url.host}
            </span>
          </a>{" "}
          &middot;{" "}
          <time datetime={article.published.toISOString()}>
            {article.published.toLocaleString("en-US", {
              dateStyle: "long",
              timeStyle: "short",
            })}
          </time>
        </p>
        <div
          class="prose dark:prose-invert mt-4 text-xl"
          dangerouslySetInnerHTML={{ __html: contentHtml }}
        />
      </article>
    );
  },
);
