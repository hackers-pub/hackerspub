import { page } from "fresh";
import { desc, eq, inArray, or } from "drizzle-orm";
import { PageTitle } from "../components/PageTitle.tsx";
import { db } from "../db.ts";
import {
  type Actor,
  followingTable,
  type Post,
  postTable,
} from "../models/schema.ts";
import { define } from "../utils.ts";
import { ArticleExcerpt } from "../components/ArticleExcerpt.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    let timeline: (Post & { actor: Actor })[];
    if (ctx.state.account == null) {
      timeline = await db.query.postTable.findMany({
        with: { actor: true },
        orderBy: desc(postTable.published),
      });
    } else {
      timeline = await db.query.postTable.findMany({
        with: { actor: true },
        where: or(
          inArray(
            postTable.actorId,
            db.select({ id: followingTable.followeeId })
              .from(followingTable)
              .where(eq(followingTable.followerId, ctx.state.account.id)),
          ),
          eq(postTable.actorId, ctx.state.account.actor.id),
        ),
        orderBy: desc(postTable.published),
      });
    }
    return page<HomeProps>({
      intro: ctx.state.account == null,
      timeline,
    });
  },
});

interface HomeProps {
  intro: boolean;
  timeline: (Post & { actor: Actor })[];
}

export default define.page<typeof handler, HomeProps>(function Home({ data }) {
  return (
    <>
      {data.intro &&
        (
          <article>
            <PageTitle>What is Hackers' Pub?</PageTitle>
            <div class="prose prose-h2:text-xl dark:prose-invert">
              <p>
                Hackers' Pub is a place for hackers to share their knowledge and
                experience with each other. It's also an ActivityPub-enabled
                social network, so you can follow your favorite hackers in the
                fediverse and get their latest posts in your feed.
              </p>
            </div>
          </article>
        )}
      {data.timeline.map((post) => (
        <ArticleExcerpt
          key={post.id}
          url={post.url ?? post.iri}
          target={post.articleSourceId == null ? "_blank" : undefined}
          title={post.summary}
          authorUrl={post.actor.url ?? post.actor.iri}
          authorName={post.actor.name ?? post.actor.username}
          authorHandle={`@${post.actor.username}@${post.actor.instanceHost}`}
          authorAvatarUrl={post.actor.avatarUrl}
          excerptHtml={post.contentHtml}
          published={post.published}
        />
      ))}
    </>
  );
});
