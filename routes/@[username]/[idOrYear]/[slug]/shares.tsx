import { desc, eq } from "drizzle-orm";
import { page } from "fresh";
import { ActorList } from "../../../../components/ActorList.tsx";
import { ArticleExcerpt } from "../../../../components/ArticleExcerpt.tsx";
import { PostReactionsNav } from "../../../../components/PostReactionsNav.tsx";
import { db } from "../../../../db.ts";
import { PostControls } from "../../../../islands/PostControls.tsx";
import { getAvatarUrl } from "../../../../models/account.ts";
import { getArticleSource } from "../../../../models/article.ts";
import { extractMentionsFromHtml } from "../../../../models/markup.ts";
import { isPostSharedBy, isPostVisibleTo } from "../../../../models/post.ts";
import {
  type Account,
  type Actor,
  postTable,
} from "../../../../models/schema.ts";
import { define } from "../../../../utils.ts";

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
    const shares = await db.query.postTable.findMany({
      with: {
        actor: {
          with: { account: true, followers: true },
        },
        mentions: true,
      },
      where: eq(postTable.sharedPostId, post.id),
      orderBy: desc(postTable.published),
    });
    const sharers = shares
      .filter((s) => isPostVisibleTo(s, ctx.state.account?.actor))
      .map((s) => s.actor);
    const sharersMentions = await extractMentionsFromHtml(
      db,
      ctx.state.fedCtx,
      sharers.map((s) => s.bioHtml).join("\n"),
      {
        documentLoader: await ctx.state.fedCtx.getDocumentLoader(
          article.account,
        ),
      },
    );
    const quotes = await db.$count(
      postTable,
      eq(postTable.quotedPostId, post.id),
    );
    return page<ArticleSharesProps>({
      article,
      sharers,
      sharersMentions,
      shared: ctx.state.account == null
        ? false
        : shares.some((share) =>
          share.actorId === ctx.state.account?.actor.id
        ) || await isPostSharedBy(db, article.post, ctx.state.account),
      quotes,
    });
  },
});

interface ArticleSharesProps {
  article: NonNullable<Awaited<ReturnType<typeof getArticleSource>>>;
  sharers: (Actor & { account?: Account | null })[];
  sharersMentions: { actor: Actor }[];
  shared: boolean;
  quotes: number;
}

export default define.page<typeof handler, ArticleSharesProps>(
  async function ArticleShares(
    { data: { article, sharers, sharersMentions, shared, quotes }, state },
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
          active="sharers"
          hrefs={{ sharers: "", quotes: `${postUrl}/quotes` }}
          stats={{ sharers: sharers.length, quotes }}
        />
        <ActorList
          actors={sharers}
          actorMentions={sharersMentions}
          class="mt-4"
        />
      </div>
    );
  },
);
