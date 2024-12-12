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
import { Msg, Translation } from "../components/Msg.tsx";
import { PostExcerpt } from "../components/PostExcerpt.tsx";
import { Composer } from "../islands/Composer.tsx";

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
              .where(eq(followingTable.followerId, ctx.state.account.actor.id)),
          ),
          eq(postTable.actorId, ctx.state.account.actor.id),
        ),
        orderBy: desc(postTable.published),
      });
    }
    return page<HomeProps>({
      intro: ctx.state.account == null || timeline.length < 1,
      composer: ctx.state.account != null,
      timeline,
    });
  },
});

interface HomeProps {
  intro: boolean;
  composer: boolean;
  timeline: (Post & { actor: Actor })[];
}

export default define.page<typeof handler, HomeProps>(
  function Home({ state, data }) {
    return (
      <Translation>
        {(_, lang) => (
          <>
            {data.composer && (
              <Composer
                language={lang}
                postUrl={`/@${state.account!.username}`}
              />
            )}
            {data.intro &&
              (
                <article>
                  <PageTitle>
                    <Msg $key="home.intro.title" />
                  </PageTitle>
                  <div class="prose prose-h2:text-xl dark:prose-invert">
                    <p>
                      <Msg $key="home.intro.content" />
                    </p>
                  </div>
                </article>
              )}
            {data.timeline.map((post) => <PostExcerpt post={post} />)}
          </>
        )}
      </Translation>
    );
  },
);
