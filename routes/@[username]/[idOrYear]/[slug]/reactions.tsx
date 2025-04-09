import { page } from "fresh";
import { ActorList } from "../../../../components/ActorList.tsx";
import { ArticleExcerpt } from "../../../../components/ArticleExcerpt.tsx";
import { Msg } from "../../../../components/Msg.tsx";
import { PageTitle } from "../../../../components/PageTitle.tsx";
import { PostReactionsNav } from "../../../../components/PostReactionsNav.tsx";
import { db } from "../../../../db.ts";
import {
  PostControls,
  toReactionStates,
} from "../../../../islands/PostControls.tsx";
import { kv } from "../../../../kv.ts";
import { getAvatarUrl } from "../../../../models/account.ts";
import { getArticleSource } from "../../../../models/article.ts";
import { extractMentionsFromHtml } from "../../../../models/markup.ts";
import { isPostVisibleTo } from "../../../../models/post.ts";
import type { Account, Actor, CustomEmoji } from "../../../../models/schema.ts";
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
  const reactions = await db.query.reactionTable.findMany({
    with: {
      actor: {
        with: { account: true },
      },
      customEmoji: true,
    },
    where: { postId: post.id },
    orderBy: { created: "desc" },
  });
  const map = new Map<
    string | string,
    (Actor & { account: Account | null })[]
  >();
  const customEmojis = new Map<string, CustomEmoji>();
  for (const reaction of reactions) {
    const emoji = reaction.customEmoji?.id ?? reaction.emoji;
    if (emoji == null) continue;
    const actor = reaction.actor;
    const list = map.get(emoji);
    if (list == null) {
      map.set(emoji, [actor]);
    } else {
      list.push(actor);
    }
    if (reaction.customEmoji != null) {
      customEmojis.set(reaction.customEmoji.id, reaction.customEmoji);
    }
  }
  const pairs: [
    string | CustomEmoji,
    (Actor & { account: Account | null })[],
  ][] = [];
  for (const [key, value] of map.entries()) {
    pairs.push([customEmojis.get(key) ?? key, value]);
  }
  pairs.sort((a, b) => {
    const aCount = a[1].length;
    const bCount = b[1].length;
    if (aCount === bCount) {
      return a[0].toString().localeCompare(b[0].toString());
    }
    return bCount - aCount;
  });
  const reactorsMentions = await extractMentionsFromHtml(
    db,
    ctx.state.fedCtx,
    pairs.flatMap(([_, s]) => s.map((a) => a.bioHtml)).join("\n"),
    {
      documentLoader: await ctx.state.fedCtx.getDocumentLoader(
        article.account,
      ),
      kv,
    },
  );
  return page<ArticleReactionsProps>({
    article,
    reactions: pairs,
    reactorsMentions,
    total: reactions.length,
  });
});

interface ArticleReactionsProps {
  article: NonNullable<Awaited<ReturnType<typeof getArticleSource>>>;
  reactions: [string | CustomEmoji, (Actor & { account: Account | null })[]][];
  reactorsMentions: { actor: Actor }[];
  total: number;
}

export default define.page<typeof handler, ArticleReactionsProps>(
  async ({ data: { article, reactions, reactorsMentions, total }, state }) => {
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
          active="reactions"
          replies={article.post.repliesCount}
          replyUrl={`${postUrl}#replies`}
          shares={article.post.sharesCount}
          shared={article.post.shares.some((share) =>
            share.actorId === state.account?.actor.id
          )}
          shareUrl={state.account == null ? undefined : `${postUrl}/share`}
          unshareUrl={state.account == null ? undefined : `${postUrl}/unshare`}
          quoteUrl={`${postUrl}/quotes`}
          quotesCount={article.post.quotesCount}
          reactUrl={state.account == null ? undefined : `${postUrl}/react`}
          reactionStates={toReactionStates(
            state.account,
            article.post.reactions,
          )}
          reactionsCounts={article.post.reactionsCounts}
          reactionsUrl={`${postUrl}/reactions`}
          deleteUrl={state.account?.id === article.accountId
            ? `${postUrl}/delete`
            : undefined}
          deleteMethod="post"
        />
        <PostReactionsNav
          active="reactions"
          hrefs={{ reactions: "", sharers: "./shares" }}
          stats={{ reactions: total, sharers: article.post.sharesCount }}
        />
        {reactions.map(([emoji, actors]) => (
          <div key={typeof emoji === "string" ? emoji : emoji.id} class="mt-4">
            <PageTitle
              subtitle={{
                text: (
                  <Msg
                    $key="post.reactions.reactedPeople"
                    count={actors.length}
                  />
                ),
              }}
            >
              {typeof emoji === "string"
                ? emoji
                : <img src={emoji.imageUrl} alt={emoji.name} class="h-4" />}
            </PageTitle>
            <ActorList
              actors={actors}
              actorMentions={reactorsMentions}
              class="mt-4"
            />
          </div>
        ))}
      </div>
    );
  },
);
