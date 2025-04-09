import { page } from "fresh";
import { ActorList } from "../../../../components/ActorList.tsx";
import { ArticleExcerpt } from "../../../../components/ArticleExcerpt.tsx";
import { PostReactionsNav } from "../../../../components/PostReactionsNav.tsx";
import { db } from "../../../../db.ts";
import { PostControls } from "../../../../islands/PostControls.tsx";
import { kv } from "../../../../kv.ts";
import { getAvatarUrl } from "../../../../models/account.ts";
import { getArticleSource } from "../../../../models/article.ts";
import { extractMentionsFromHtml } from "../../../../models/markup.ts";
import { isPostVisibleTo } from "../../../../models/post.ts";
import type { Account, Actor } from "../../../../models/schema.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
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
  const shares = await db.query.postTable.findMany({
    with: {
      actor: {
        with: { account: true, followers: true },
      },
      mentions: true,
    },
    where: { sharedPostId: post.id },
    orderBy: { published: "desc" },
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
      kv,
    },
  );
  return page<ArticleSharesProps>({
    article,
    sharers,
    sharersMentions,
  });
});

interface ArticleSharesProps {
  article: NonNullable<Awaited<ReturnType<typeof getArticleSource>>>;
  sharers: (Actor & { account?: Account | null })[];
  sharersMentions: { actor: Actor }[];
}

export default define.page<typeof handler, ArticleSharesProps>(
  async function ArticleShares(
    { data: { article, sharers, sharersMentions }, state },
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
          post={article.post}
          signedAccount={state.account}
        />
        <PostControls
          language={state.language}
          post={article.post}
          class="mt-8"
          active="reactions"
          signedAccount={state.account}
        />
        <PostReactionsNav
          active="sharers"
          hrefs={{ reactions: "./reactions", sharers: "" }}
          stats={{
            reactions: Object.values(article.post.reactionsCounts).reduce(
              (a, b) => a + b,
              0,
            ),
            sharers: sharers.length,
          }}
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
