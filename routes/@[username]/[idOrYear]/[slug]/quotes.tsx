import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { page } from "fresh";
import { ArticleExcerpt } from "../../../../components/ArticleExcerpt.tsx";
import { Msg } from "../../../../components/Msg.tsx";
import { PostExcerpt } from "../../../../components/PostExcerpt.tsx";
import { db } from "../../../../db.ts";
import { drive } from "../../../../drive.ts";
import { Composer } from "../../../../islands/Composer.tsx";
import { PostControls } from "../../../../islands/PostControls.tsx";
import { kv } from "../../../../kv.ts";
import { getAvatarUrl } from "../../../../models/account.ts";
import { getArticleSource } from "../../../../models/article.ts";
import { createNote } from "../../../../models/note.ts";
import { isPostSharedBy, isPostVisibleTo } from "../../../../models/post.ts";
import type {
  Actor,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
} from "../../../../models/schema.ts";
import { define } from "../../../../utils.ts";
import { NoteSourceSchema } from "../../index.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const username = ctx.params.username;
    const year = parseInt(ctx.params.idOrYear);
    const slug = ctx.params.slug;
    const article = await getArticleSource(db, username, year, slug);
    if (article == null) return ctx.next();
    const post = article.post;
    if (!isPostVisibleTo(post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const quotes = await db.query.postTable.findMany({
      with: {
        actor: { with: { instance: true } },
        link: {
          with: { creator: true },
        },
        mentions: {
          with: { actor: true },
        },
        media: true,
        shares: {
          where: ctx.state.account == null
            ? { RAW: sql`false` }
            : { actorId: ctx.state.account.actor.id },
        },
      },
      where: {
        quotedPostId: article.post.id,
        sharedPostId: { isNull: true },
      },
      orderBy: { published: "desc" },
    });
    const shared = await isPostSharedBy(db, article.post, ctx.state.account);
    return page<ArticleQuotesProps>({
      article,
      quotes,
      shared,
    });
  },

  async POST(ctx) {
    if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const username = ctx.params.username;
    const year = parseInt(ctx.params.idOrYear);
    const slug = ctx.params.slug;
    const article = await getArticleSource(db, username, year, slug);
    if (article == null) return ctx.next();
    const post = article.post;
    if (!isPostVisibleTo(post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    if (ctx.state.account == null) {
      return new Response("Forbidden", { status: 403 });
    }
    const payload = await ctx.req.json();
    const parsed = await v.safeParseAsync(NoteSourceSchema, payload);
    if (!parsed.success) {
      return new Response(JSON.stringify(parsed.issues), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const disk = drive.use();
    const quote = await createNote(db, kv, disk, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    }, { quotedPost: article.post });
    if (quote == null) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify(quote), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  },
});

interface ArticleQuotesProps {
  article: NonNullable<Awaited<ReturnType<typeof getArticleSource>>>;
  quotes: (
    Post & {
      actor: Actor & { instance: Instance };
      link: PostLink & { creator?: Actor | null } | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
    }
  )[];
  shared: boolean;
}

export default define.page<typeof handler, ArticleQuotesProps>(
  async function ArticleQuotes(
    { data: { article, quotes, shared }, state },
  ) {
    const postUrl =
      `/@${article.account.username}/${article.publishedYear}/${article.slug}`;
    const avatarUrl = await getAvatarUrl(article.account);
    return (
      <div>
        <ArticleExcerpt
          url={postUrl}
          visibility={article.post.visibility}
          title={article.title}
          contentHtml={article.post.contentHtml}
          published={article.published}
          authorName={article.account.name}
          authorHandle={article.post.actor.handle}
          authorUrl={`/@${article.account.username}`}
          authorAvatarUrl={avatarUrl}
          lang={article.language}
          editUrl={state.account?.id === article.accountId
            ? `${postUrl}/edit`
            : null}
          deleteUrl={state.account?.id === article.accountId
            ? `${postUrl}/delete`
            : null}
        />
        <PostControls
          language={state.language}
          visibility={article.post.visibility}
          class="mt-8"
          active="quote"
          replies={article.post.repliesCount}
          replyUrl={`${postUrl}#replies`}
          shares={article.post.sharesCount}
          shared={shared}
          shareUrl={state.account == null ? undefined : `${postUrl}/share`}
          unshareUrl={state.account == null ? undefined : `${postUrl}/unshare`}
          quoteUrl=""
          quotesCount={quotes.length}
          reactionsUrl={`${postUrl}/shares`}
          deleteUrl={state.account?.id === article.accountId
            ? `${postUrl}/delete`
            : undefined}
          deleteMethod="post"
        />
        <div class="mt-8">
          {state.account == null
            ? (
              <>
                <p class="mb-8 leading-7 text-stone-500 dark:text-stone-400">
                  <Msg
                    $key="article.remoteQuoteDescription"
                    permalink={
                      <span class="font-bold border-dashed border-b-[1px] select-all text-stone-950 dark:text-stone-50">
                        {article.post.iri}
                      </span>
                    }
                  />
                </p>
              </>
            )
            : (
              <Composer
                language={state.language}
                postUrl=""
                noQuoteOnPaste
                onPost="post.url"
              />
            )}
          {quotes.map((quote) => (
            <PostExcerpt
              key={quote.id}
              post={{ ...quote, sharedPost: null, replyTarget: null }}
              noQuote
            />
          ))}
        </div>
      </div>
    );
  },
);
