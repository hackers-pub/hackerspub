import { page } from "@fresh/core";
import { getArticleSource } from "@hackerspub/models/article";
import { extractMentionsFromHtml } from "@hackerspub/models/markup";
import {
  getCensoredPostExclusionFilter,
  isPostVisibleTo,
} from "@hackerspub/models/post";
import type { Account, Actor } from "@hackerspub/models/schema";
import {
  isPostCensoredFor,
  redactCensoredPost,
} from "../../../../censorship.ts";
import { ActorList } from "../../../../components/ActorList.tsx";
import { PostReactionsNav } from "../../../../components/PostReactionsNav.tsx";
import { db } from "../../../../db.ts";
import { ArticleExcerpt } from "../../../../islands/ArticleExcerpt.tsx";
import { PostControls } from "../../../../islands/PostControls.tsx";
import { kv } from "../../../../kv.ts";
import { define } from "../../../../utils.ts";

export const handler = define.handlers(async (ctx) => {
  if (!ctx.params.idOrYear.match(/^\d+$/)) return ctx.next();
  const username = ctx.params.username;
  const year = parseInt(ctx.params.idOrYear);
  const slug = ctx.params.slug;
  let article = await getArticleSource(
    db,
    username,
    year,
    slug,
    ctx.state.account,
  );
  if (article == null) return ctx.next();
  if (!isPostVisibleTo(article.post, ctx.state.account?.actor)) {
    return ctx.next();
  }
  const censored = isPostCensoredFor(article.post, ctx.state.account);
  if (censored) {
    article = {
      ...article,
      post: redactCensoredPost(article.post, ctx.state.t),
    };
  }
  const post = article.post;
  // Boosts of a censored post are moderation-hidden everywhere else
  // (getCensoredPostExclusionFilter), so when the original is censored the
  // whole sharer list is suppressed: it would reveal who amplified the
  // hidden content.  When the original is not censored, an individual boost
  // wrapper may still be censored on its own, so the same exclusion filter
  // drops those wrappers (keeping a booster's own censored boost visible to
  // them, like the timeline and search lists).
  const shares = censored ? [] : await db.query.postTable.findMany({
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
    where: {
      AND: [
        { sharedPostId: post.id },
        getCensoredPostExclusionFilter(ctx.state.account?.actor.id),
      ],
    },
    orderBy: { published: "desc" },
  });
  const sharers = shares
    .filter((s) => isPostVisibleTo(s, ctx.state.account?.actor))
    .map((s) => s.actor);
  const sharersMentions = await extractMentionsFromHtml(
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
        language={state.language}
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
        canonicalOrigin={state.canonicalOrigin}
        actors={sharers}
        actorMentions={sharersMentions}
        class="mt-4"
      />
    </div>
  ),
);
