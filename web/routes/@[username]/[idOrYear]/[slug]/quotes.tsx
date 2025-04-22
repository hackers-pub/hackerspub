import { page } from "@fresh/core";
import { getArticleSource } from "@hackerspub/models/article";
import { createNote } from "@hackerspub/models/note";
import { isPostVisibleTo } from "@hackerspub/models/post";
import type {
  Actor,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "@hackerspub/models/schema";
import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { ArticleExcerpt } from "../../../../components/ArticleExcerpt.tsx";
import { Msg } from "../../../../components/Msg.tsx";
import { PostExcerpt } from "../../../../components/PostExcerpt.tsx";
import { db } from "../../../../db.ts";
import { drive } from "../../../../drive.ts";
import { Composer } from "../../../../islands/Composer.tsx";
import { PostControls } from "../../../../islands/PostControls.tsx";
import { kv } from "../../../../kv.ts";
import { define } from "../../../../utils.ts";
import { NoteSourceSchema } from "../../index.tsx";

export const handler = define.handlers({
  async GET(ctx) {
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
        reactions: {
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
    return page<ArticleQuotesProps>({
      article,
      quotes,
    });
  },

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
      reactions: Reaction[];
    }
  )[];
}

export default define.page<typeof handler, ArticleQuotesProps>(
  ({ data: { article, quotes }, state }) => (
    <div>
      <ArticleExcerpt
        post={article.post}
        signedAccount={state.account}
      />
      <PostControls
        language={state.language}
        post={article.post}
        class="mt-8"
        active="quote"
        signedAccount={state.account}
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
  ),
);
