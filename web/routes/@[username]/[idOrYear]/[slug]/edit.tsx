import { page } from "@fresh/core";
import {
  getArticleSource,
  getOriginalArticleContent,
  updateArticle,
} from "@hackerspub/models/article";
import type { Account } from "@hackerspub/models/schema";
import * as v from "@valibot/valibot";
import { db } from "../../../../db.ts";
import { Editor } from "../../../../islands/Editor.tsx";
import { define } from "../../../../utils.ts";

const ArticleSourceSchema = v.object({
  title: v.pipe(v.string(), v.trim()),
  content: v.string(),
  language: v.pipe(v.string(), v.trim(), v.maxLength(2)),
});

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.state.account == null) return ctx.next();
    else if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const year = parseInt(ctx.params.idOrYear);
    const article = await getArticleSource(
      db,
      ctx.params.username,
      year,
      ctx.params.slug,
      ctx.state.account,
    );
    if (article == null) return ctx.next();
    else if (article.accountId !== ctx.state.account.id) return ctx.next();
    ctx.state.withoutMain = true;
    const content = getOriginalArticleContent(article);
    if (content == null) return ctx.next();
    return page<ArticleEditPageProps>({
      account: article.account,
      tags: article.tags,
      slug: article.slug,
      title: content.title,
      content: content.content,
      language: content.language,
      permalink: new URL(
        `/@${article.account.username}/${article.publishedYear}/${article.slug}`,
        ctx.url,
      ).href,
    });
  },

  async POST(ctx) {
    if (ctx.state.account == null) return ctx.next();
    else if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const year = parseInt(ctx.params.idOrYear);
    const article = await getArticleSource(
      db,
      ctx.params.username,
      year,
      ctx.params.slug,
      ctx.state.account,
    );
    if (article == null) return ctx.next();
    else if (article.accountId !== ctx.state.account.id) return ctx.next();
    const data = await ctx.req.json();
    const result = v.safeParse(ArticleSourceSchema, data);
    if (!result.success) {
      return new Response(
        JSON.stringify(result.issues),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    const post = await updateArticle(
      ctx.state.fedCtx,
      article.id,
      result.output,
    );
    if (post == null) {
      return new Response(
        JSON.stringify({ error: "Failed to update" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ id: article.id }),
      {
        status: 201,
        headers: {
          "Access-Control-Expose-Headers": "Location",
          "Content-Type": "application/json",
          Location: post.url!,
        },
      },
    );
  },
});

interface ArticleEditPageProps {
  account: Account;
  title: string;
  content: string;
  tags: string[];
  permalink: string;
  slug: string;
  language: string;
}

export default define.page<typeof handler, ArticleEditPageProps>(
  function ArticleEditPage({ url, data, state }) {
    return (
      <main class="w-full h-[calc(100vh-3.75rem)]">
        <Editor
          language={state.language}
          class="w-full h-full"
          previewUrl={new URL("/api/preview", url).href}
          publishUrl={url.href}
          permalink={data.permalink}
          slug={data.slug}
          articleLanguage={data.language}
          defaultTitle={data.title}
          defaultContent={data.content}
          defaultTags={data.tags}
        />
      </main>
    );
  },
);
