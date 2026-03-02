import * as vocab from "@fedify/vocab";
import { type FreshContext, page } from "@fresh/core";
import { getAvatarUrl } from "@hackerspub/models/account";
import {
  getArticleSource,
  getOriginalArticleContent,
  startArticleContentSummary,
  updateArticle,
} from "@hackerspub/models/article";
import { preprocessContentHtml } from "@hackerspub/models/html";
import { renderMarkup, type Toc } from "@hackerspub/models/markup";
import { createNote } from "@hackerspub/models/note";
import { isPostVisibleTo } from "@hackerspub/models/post";
import type {
  Actor,
  ArticleContent,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "@hackerspub/models/schema";
import { withTransaction } from "@hackerspub/models/tx";
import type { Uuid } from "@hackerspub/models/uuid";
import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { summarizer } from "../../../../ai.ts";
import { Msg } from "../../../../components/Msg.tsx";
import { PageTitle } from "../../../../components/PageTitle.tsx";
import { PostExcerpt } from "../../../../components/PostExcerpt.tsx";
import { db } from "../../../../db.ts";
import { drive } from "../../../../drive.ts";
import { ArticleMetadata } from "../../../../islands/ArticleMetadata.tsx";
import { Composer } from "../../../../islands/Composer.tsx";
import { PostControls } from "../../../../islands/PostControls.tsx";
import { kv } from "../../../../kv.ts";
import { define, type State } from "../../../../utils.ts";
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
      ctx.state.account,
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
      await updateArticle(ctx.state.fedCtx, article.id, {});
    }
    const content = getOriginalArticleContent(article);
    if (content == null) return ctx.next();
    const props = await handleArticle(ctx, article, content, permalink);
    return page<ArticlePageProps>(props, {
      headers: {
        Link:
          `<${props.articleIri}>; rel="alternate"; type="application/activity+json"`,
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
      ctx.state.account,
    );
    if (article == null) return ctx.next();
    const account = ctx.state.account;
    if (account == null) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!isPostVisibleTo(article.post, account.actor)) {
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
    const quotedPost = parsed.output.quotedPostId == null
      ? undefined
      : await db.query.postTable.findFirst({
        where: {
          id: parsed.output.quotedPostId as Uuid,
          visibility: { in: ["public", "unlisted"] },
        },
        with: { actor: true },
      });
    return await withTransaction(ctx.state.fedCtx, async (context) => {
      const post = await createNote(context, {
        ...parsed.output,
        accountId: account.id,
      }, { replyTarget: article.post, quotedPost });
      if (post == null) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify(post), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
  },
});

export async function handleArticle(
  ctx: FreshContext<State>,
  article: NonNullable<Awaited<ReturnType<typeof getArticleSource>>>,
  content: ArticleContent,
  permalink: URL,
): Promise<ArticlePageProps> {
  const rendered = await renderMarkup(
    ctx.state.fedCtx,
    content.content,
    {
      docId: article.id,
      kv,
      refresh: ctx.url.searchParams.has("refresh") &&
        ctx.state.account?.moderator,
    },
  );
  const articleUri = ctx.state.fedCtx.getObjectUri(
    vocab.Article,
    { id: article.id },
  );
  ctx.state.title = content.title;
  ctx.state.links.push(
    { rel: "canonical", href: permalink },
    {
      rel: "alternate",
      type: "application/activity+json",
      href: articleUri,
    },
  );
  const description = content.summary ?? rendered.text;
  if (content.summary == null) {
    await startArticleContentSummary(db, summarizer, content);
  }
  ctx.state.metas.push(
    { name: "description", content: description },
    { property: "og:title", content: content.title },
    { property: "og:site_name", content: "Hackers' Pub" },
    { property: "og:description", content: description },
    { property: "og:url", content: permalink },
    { property: "og:type", content: "article" },
    { property: "og:locale", content: content.language.replace("-", "_") },
    ...(article.contents.filter((c) => c.language !== content.language).map(
      (c) => ({
        property: "og:locale:alternate",
        content: c.language.replace("-", "_"),
      }),
    )),
    {
      property: "og:image",
      content: new URL(
        `/@${article.account.username}/${article.publishedYear}/${article.slug}/ogimage?l=${
          encodeURIComponent(content.language)
        }`,
        ctx.state.canonicalOrigin,
      ),
    },
    { property: "og:image:width", content: 1200 },
    { property: "og:image:height", content: 630 },
    { name: "twitter:card", content: "summary_large_image" },
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
      actor: { with: { instance: true } },
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
      reactions: {
        where: ctx.state.account == null
          ? { RAW: sql`false` }
          : { actorId: ctx.state.account.actor.id },
      },
    },
    where: { replyTargetId: article.post.id },
    orderBy: { published: "asc" },
  });
  const disk = drive.use();
  return {
    article,
    content,
    articleIri: articleUri.href,
    comments,
    avatarUrl: await getAvatarUrl(disk, article.account),
    contentHtml: preprocessContentHtml(
      rendered.html,
      {
        ...article.post,
        quote: article.post.quotedPostId != null,
      },
    ),
    toc: rendered.toc,
    state: ctx.state,
  };
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

export interface ArticlePageProps {
  article: NonNullable<Awaited<ReturnType<typeof getArticleSource>>>;
  content: ArticleContent;
  articleIri: string;
  comments: (Post & {
    actor: Actor & { instance: Instance };
    link: PostLink & { creator?: Actor | null } | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
    reactions: Reaction[];
  })[];
  avatarUrl: string;
  contentHtml: string;
  toc: Toc[];
  state: State;
}

export function ArticlePage(
  {
    article,
    content,
    articleIri,
    comments,
    avatarUrl,
    contentHtml,
    toc,
    state,
  }: ArticlePageProps,
) {
  const authorHandle = `@${article.account.username}@${
    new URL(articleIri).host
  }`;
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
  const originalContent = getOriginalArticleContent(article);
  const displayNames = new Intl.DisplayNames(state.language, {
    type: "language",
  });
  return (
    <>
      <article>
        {content.beingTranslated
          ? (
            <h1 class="text-4xl font-bold">
              <Msg
                $key="article.beingTranslated"
                targetLanguage={displayNames.of(content.language)}
              />
            </h1>
          )
          : (
            <h1 class="text-4xl font-bold" lang={content.language}>
              {content.title}
            </h1>
          )}
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
        {!content.beingTranslated && toc.length > 0 &&
          (
            <nav class="
                mt-4 p-4 bg-stone-100 dark:bg-stone-800 w-fit xl:max-w-md
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
        {(content.originalLanguage != null ||
          article.allowLlmTranslation && state.account ||
          article.contents.length > 1) &&
          (
            <aside class="
              mt-8 p-4 max-w-[80ch] border border-stone-200 dark:border-stone-700
              flex flex-row gap-4
            ">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="size-8 stroke-2 opacity-50 mb-4"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="m10.5 21 5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 0 1 6-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 0 1-3.827-5.802"
                />
              </svg>
              <div>
                {content.beingTranslated
                  ? (
                    <p class="mb-4">
                      <Msg
                        $key="article.beingTranslatedDescription"
                        targetLanguage={
                          <strong>{displayNames.of(content.language)}</strong>
                        }
                        sourceLanguage={
                          <a
                            href={postUrl}
                            hreflang={content.originalLanguage ?? undefined}
                          >
                            <strong>
                              {displayNames.of(
                                content.originalLanguage ?? "en",
                              )}
                            </strong>
                          </a>
                        }
                      />
                    </p>
                  )
                  : content.originalLanguage == null
                  ? undefined
                  : (
                    <p class="mb-4">
                      <Msg
                        $key="article.translated"
                        targetLanguage={
                          <strong>{displayNames.of(content.language)}</strong>
                        }
                        sourceLanguage={
                          <a
                            href={postUrl}
                            hreflang={content.originalLanguage}
                          >
                            <strong>
                              {displayNames.of(content.originalLanguage)}
                            </strong>
                          </a>
                        }
                      />
                    </p>
                  )}
                {(article.allowLlmTranslation && state.account
                  ? state.locales.find((l) =>
                    l !== content.language &&
                    (l.replace(/-.*$/, "") !==
                        originalContent?.language?.replace(/-.*$/, "") ||
                      l === originalContent?.language)
                  )
                  : article.contents.find((c) =>
                    c.language !== content.language
                  )) && (
                  <nav class="text-stone-600 dark:text-stone-400">
                    <strong>
                      <Msg $key="article.otherLanguages" />
                    </strong>{" "}
                    &rarr; {(article.allowLlmTranslation && state.account
                      ? state.locales
                      : article.contents.map((c) => c.language))
                      .filter((l) =>
                        l !== content.language &&
                        (l.replace(/-.*$/, "") !==
                            originalContent?.language?.replace(/-.*$/, "") ||
                          l === originalContent?.language)
                      )
                      .map((l, i) => {
                        const displayNames = new Intl.DisplayNames(l, {
                          type: "language",
                        });
                        return (
                          <>
                            {i > 0 && <>{" "}&middot;{" "}</>}
                            <a
                              key={l}
                              href={originalContent?.language === l
                                ? postUrl
                                : `${postUrl}/${l}`}
                              hreflang={l}
                              lang={l}
                              rel="alternate"
                              class="text-stone-900 dark:text-stone-100"
                            >
                              {displayNames.of(l)}
                            </a>
                          </>
                        );
                      })}
                  </nav>
                )}
              </div>
            </aside>
          )}
        {!content.beingTranslated && (
          <div
            lang={content.language}
            class="prose dark:prose-invert mt-4 text-xl leading-8"
            dangerouslySetInnerHTML={{ __html: contentHtml }}
          />
        )}
        <PostControls
          language={state.language}
          post={article.post}
          class="mt-8"
          active="reply"
          signedAccount={state.account}
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
              defaultVisibility={state.account!.noteVisibility}
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
}

export default define.page<typeof handler, ArticlePageProps>(
  ({ data }) => <ArticlePage {...data} />,
);
