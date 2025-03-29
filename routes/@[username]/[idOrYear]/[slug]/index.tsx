import * as vocab from "@fedify/fedify/vocab";
import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { page } from "fresh";
import { Msg } from "../../../../components/Msg.tsx";
import { PageTitle } from "../../../../components/PageTitle.tsx";
import { PostExcerpt } from "../../../../components/PostExcerpt.tsx";
import { db } from "../../../../db.ts";
import { drive } from "../../../../drive.ts";
import { ArticleMetadata } from "../../../../islands/ArticleMetadata.tsx";
import { Composer } from "../../../../islands/Composer.tsx";
import { PostControls } from "../../../../islands/PostControls.tsx";
import { kv } from "../../../../kv.ts";
import { getAvatarUrl } from "../../../../models/account.ts";
import { getArticleSource, updateArticle } from "../../../../models/article.ts";
import { preprocessContentHtml } from "../../../../models/html.ts";
import { renderMarkup, type Toc } from "../../../../models/markup.ts";
import { createNote } from "../../../../models/note.ts";
import { isPostSharedBy, isPostVisibleTo } from "../../../../models/post.ts";
import type {
  Account,
  Actor,
  ArticleSource,
  Mention,
  Post,
  PostLink,
  PostMedium,
} from "../../../../models/schema.ts";
import type { Uuid } from "../../../../models/uuid.ts";
import { define } from "../../../../utils.ts";
import { NoteSourceSchema } from "../../index.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
    const year = parseInt(ctx.params.idOrYear);
    const article = await getArticleSource(
      db,
      ctx.params.username,
      year,
      ctx.params.slug,
    );
    if (article == null) return ctx.next();
    if (!isPostVisibleTo(article.post, ctx.state.account?.actor)) {
      return ctx.next();
    }
    const permalink = new URL(
      `/@${article.account.username}/${article.publishedYear}/${article.slug}`,
      ctx.state.canonicalOrigin,
    );
    if (
      ctx.state.account?.moderator &&
        ctx.url.searchParams.has("refresh") ||
      ctx.params.username !== article.account.username &&
        article.post.url !== permalink.href
    ) {
      await updateArticle(db, kv, ctx.state.fedCtx, article.id, {});
    }
    const articleUri = ctx.state.fedCtx.getObjectUri(
      vocab.Article,
      { id: article.id },
    );
    const content = await renderMarkup(db, ctx.state.fedCtx, article.content, {
      docId: article.id,
      kv,
      refresh: ctx.url.searchParams.has("refresh") &&
        ctx.state.account?.moderator,
    });
    ctx.state.title = article.title;
    ctx.state.links.push(
      { rel: "canonical", href: permalink },
      {
        rel: "alternate",
        type: "application/activity+json",
        href: articleUri,
      },
    );
    const description = content.text; // FIXME: Summarize content
    ctx.state.metas.push(
      { name: "description", content: description },
      { property: "og:title", content: article.title },
      { property: "og:site_name", content: "Hackers' Pub" },
      { property: "og:description", content: description },
      { property: "og:url", content: permalink },
      { property: "og:type", content: "article" },
      { property: "og:locale", content: article.language },
      {
        property: "og:image",
        content: new URL(
          `/@${article.account.username}/${article.publishedYear}/${article.slug}/og`,
          ctx.state.canonicalOrigin,
        ),
      },
      { property: "og:image:width", content: 1200 },
      { property: "og:image:height", content: 630 },
      {
        property: "article:published_time",
        content: article.published.toISOString(),
      },
      {
        property: "article:modified_time",
        content: article.updated.toISOString(),
      },
      { property: "article:author", content: article.account.name },
      {
        property: "article:author.username",
        content: article.account.username,
      },
      ...article.tags.map((tag) => ({ property: "article:tag", content: tag })),
      {
        name: "fediverse:creator",
        content: `${article.account.username}@${
          new URL(ctx.state.canonicalOrigin).host
        }`,
      },
    );
    const comments = await db.query.postTable.findMany({
      with: {
        actor: true,
        link: { with: { creator: true } },
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
      where: { replyTargetId: article.post.id },
      orderBy: { published: "asc" },
    });
    return page<ArticlePageProps>({
      article,
      articleIri: articleUri.href,
      shared: await isPostSharedBy(db, article.post, ctx.state.account),
      comments,
      avatarUrl: await getAvatarUrl(article.account),
      contentHtml: preprocessContentHtml(
        content.html,
        article.post.mentions,
        article.post.emojis,
      ),
      toc: content.toc,
    }, {
      headers: {
        Link:
          `<${articleUri.href}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },

  async POST(ctx) {
    const year = parseInt(ctx.params.idOrYear);
    const article = await getArticleSource(
      db,
      ctx.params.username,
      year,
      ctx.params.slug,
    );
    if (article == null) return ctx.next();
    if (ctx.state.account == null) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!isPostVisibleTo(article.post, ctx.state.account?.actor)) {
      return ctx.next();
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
    const quotedPost = parsed.output.quotedPostId == null
      ? undefined
      : await db.query.postTable.findFirst({
        where: {
          id: parsed.output.quotedPostId as Uuid,
          visibility: { in: ["public", "unlisted"] },
        },
      });
    const post = await createNote(db, kv, disk, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    }, { replyTarget: article.post, quotedPost });
    if (post == null) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify(post), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  },
});

interface ArticlePageProps {
  article: ArticleSource & {
    account: Account;
    post: Post & { mentions: (Mention & { actor: Actor })[] };
  };
  articleIri: string;
  shared: boolean;
  comments: (Post & {
    actor: Actor;
    link: PostLink & { creator?: Actor | null } | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
  })[];
  avatarUrl: string;
  contentHtml: string;
  toc: Toc[];
}

interface TableOfContentsProps {
  toc: Toc[];
  class?: string;
}

function TableOfContents({ toc, class: cls }: TableOfContentsProps) {
  return (
    <ol class={cls}>
      {toc.map((item) => (
        <li key={item.id} class="leading-7 text-sm">
          <a
            href={`#${encodeURIComponent(item.id)}`}
          >
            {item.title}
          </a>
          {item.children.length > 0 && (
            <TableOfContents toc={item.children} class="ml-6" />
          )}
        </li>
      ))}
    </ol>
  );
}

export default define.page<typeof handler, ArticlePageProps>(
  function ArticlePage(
    {
      url,
      state,
      data: {
        article,
        articleIri,
        shared,
        comments,
        avatarUrl,
        contentHtml,
        toc,
      },
    },
  ) {
    const authorHandle = `@${article.account.username}@${url.host}`;
    const commentTargets = article.post.mentions
      .filter((m) =>
        m.actorId !== article.post.actorId &&
        m.actorId !== state.account?.actor.id
      )
      .map((m) => m.actor.handle);
    if (
      !commentTargets.includes(authorHandle) &&
      state.account?.id !== article.accountId
    ) {
      commentTargets.unshift(authorHandle);
    }
    const postUrl =
      `/@${article.account.username}/${article.publishedYear}/${article.slug}`;
    return (
      <>
        <article>
          <h1 class="text-4xl font-bold" lang={article.language}>
            {article.title}
          </h1>
          <ArticleMetadata
            language={state.language}
            class="mt-4"
            authorUrl={`/@${article.account.username}`}
            authorName={article.account.name}
            authorHandle={authorHandle}
            authorAvatarUrl={avatarUrl}
            published={article.published}
            editUrl={state.account?.id === article.accountId
              ? `${postUrl}/edit`
              : null}
            deleteUrl={state.account?.id === article.accountId
              ? `${postUrl}/delete`
              : null}
          />
          {toc.length > 0 &&
            (
              <nav class="
                mt-4 p-4 bg-stone-100 dark:bg-stone-800 w-fit
                xl:absolute right-[calc((100%-1280px)/2)]
              ">
                <p class="
                  font-bold text-sm leading-7 uppercase
                  text-stone-500 dark:text-stone-400
                ">
                  <Msg $key="article.tableOfContents" />
                </p>
                <TableOfContents toc={toc} />
              </nav>
            )}
          <div
            lang={article.language}
            class="prose dark:prose-invert mt-4 text-xl leading-8"
            dangerouslySetInnerHTML={{ __html: contentHtml }}
          />
          <PostControls
            language={state.language}
            class="mt-8"
            active="reply"
            replies={comments.length}
            shares={article.post.sharesCount}
            shared={shared}
            shareUrl={state.account == null ? undefined : `${postUrl}/share`}
            unshareUrl={state.account == null
              ? undefined
              : `${postUrl}/unshare`}
            reactionsUrl={`${postUrl}/shares`}
            deleteUrl={state.account?.id === article.accountId
              ? `${postUrl}/delete`
              : undefined}
            deleteMethod="post"
          />
        </article>
        <div id="replies">
          <PageTitle class="mt-8">
            <Msg $key="article.comments" count={comments.length} />
          </PageTitle>
          {state.account == null
            ? (
              <p class="mt-4 leading-7">
                <Msg
                  $key="article.remoteCommentDescription"
                  permalink={
                    <span class="font-bold border-dashed border-b-[1px] select-all">
                      {articleIri}
                    </span>
                  }
                />
              </p>
            )
            : (
              <Composer
                class="mt-4"
                commentTargets={commentTargets}
                language={state.language}
                postUrl={postUrl}
                onPost="reload"
              />
            )}
          {comments.map((comment) => (
            <PostExcerpt
              key={comment.id}
              post={{ ...comment, sharedPost: null, replyTarget: null }}
              signedAccount={state.account}
            />
          ))}
        </div>
      </>
    );
  },
);
