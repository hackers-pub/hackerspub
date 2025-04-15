import { page } from "fresh";
import { ActorList } from "../../../../components/ActorList.tsx";
import { ArticleExcerpt } from "../../../../components/ArticleExcerpt.tsx";
import { PostReactionsNav } from "../../../../components/PostReactionsNav.tsx";
import { db } from "../../../../db.ts";
import { drive } from "../../../../drive.ts";
import { PostControls } from "../../../../islands/PostControls.tsx";
import { kv } from "../../../../kv.ts";
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
        with: {
          account: true,
          followers: true,
          blockees: true,
          blockers: true,
        },
      },
      mentions: true,
    },
    where: { sharedPostId: post.id },
    orderBy: { published: "desc" },
  });
  const sharers = shares
    .filter((s) => isPostVisibleTo(s, ctx.state.account?.actor))
    .map((s) => s.actor);
  const disk = drive.use();
  const sharersMentions = await extractMentionsFromHtml(
    db,
    disk,
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
  ({ data: { article, sharers, sharersMentions }, state }) => (
    <div>
      <ArticleExcerpt
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
          reactions: article.post.reactionsCount,
          sharers: sharers.length,
        }}
      />
      <ActorList
        actors={sharers}
        actorMentions={sharersMentions}
        class="mt-4"
      />
    </div>
  ),
);
