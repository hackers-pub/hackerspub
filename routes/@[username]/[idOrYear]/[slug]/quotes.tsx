import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { page } from "fresh";
import { ArticleExcerpt } from "../../../../components/ArticleExcerpt.tsx";
import { PostExcerpt } from "../../../../components/PostExcerpt.tsx";
import { PostReactionsNav } from "../../../../components/PostReactionsNav.tsx";
import { db } from "../../../../db.ts";
import { PostControls } from "../../../../islands/PostControls.tsx";
import { getAvatarUrl } from "../../../../models/account.ts";
import { getArticleSource } from "../../../../models/article.ts";
import { isPostSharedBy, isPostVisibleTo } from "../../../../models/post.ts";
import {
  type Actor,
  type Mention,
  type Post,
  type PostLink,
  type PostMedium,
  postTable,
} from "../../../../models/schema.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
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
      actor: true,
      link: {
        with: { creator: true },
      },
      mentions: {
        with: { actor: true },
      },
      media: true,
      shares: {
        where: ctx.state.account == null
          ? sql`false`
          : eq(postTable.actorId, ctx.state.account.actor.id),
      },
    },
    where: and(
      eq(postTable.quotedPostId, article.post.id),
      isNull(postTable.sharedPostId),
    ),
    orderBy: desc(postTable.published),
  });
  const sharers = await db.$count(
    postTable,
    eq(postTable.sharedPostId, article.post.id),
  );
  const shared = await isPostSharedBy(db, article.post, ctx.state.account);
  return page<ArticleQuotesProps>({
    article,
    quotes,
    sharers,
    shared,
  });
});

interface ArticleQuotesProps {
  article: NonNullable<Awaited<ReturnType<typeof getArticleSource>>>;
  quotes: (
    Post & {
      actor: Actor;
      link: PostLink & { creator?: Actor | null } | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
    }
  )[];
  shared: boolean;
  sharers: number;
}

export default define.page<typeof handler, ArticleQuotesProps>(
  async function ArticleQuotes(
    { data: { article, quotes, shared, sharers }, state },
  ) {
    const postUrl =
      `/@${article.account.username}/${article.publishedYear}/${article.slug}`;
    const avatarUrl = await getAvatarUrl(article.account);
    return (
      <div>
        <ArticleExcerpt
          url={postUrl}
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
          class="mt-8"
          active="sharedPeople"
          replies={article.post.repliesCount}
          replyUrl={`${postUrl}#replies`}
          shares={article.post.sharesCount}
          shared={shared}
          shareUrl={state.account == null ? undefined : `${postUrl}/share`}
          unshareUrl={state.account == null ? undefined : `${postUrl}/unshare`}
          reactionsUrl={`${postUrl}/shares`}
          deleteUrl={state.account?.id === article.accountId
            ? `${postUrl}/delete`
            : undefined}
          deleteMethod="post"
        />
        <PostReactionsNav
          active="quotes"
          hrefs={{ sharers: `${postUrl}/shares`, quotes: "" }}
          stats={{ sharers: sharers, quotes: quotes.length }}
        />
        {quotes.map((quote) => (
          <PostExcerpt
            key={quote.id}
            post={{ ...quote, sharedPost: null, replyTarget: null }}
            noQuote
          />
        ))}
      </div>
    );
  },
);
