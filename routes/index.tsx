import { acceptsLanguages } from "@std/http/negotiation";
import { page } from "fresh";
import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { PageTitle } from "../components/PageTitle.tsx";
import { db } from "../db.ts";
import {
  type Actor,
  followingTable,
  type Medium,
  mentionTable,
  type Post,
  postTable,
} from "../models/schema.ts";
import { define } from "../utils.ts";
import { Msg, Translation } from "../components/Msg.tsx";
import { PostExcerpt } from "../components/PostExcerpt.tsx";
import { Composer } from "../islands/Composer.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    let timeline: (Post & {
      actor: Actor;
      sharedPost:
        | Post & {
          actor: Actor;
          replyTarget: Post & { actor: Actor; media: Medium[] } | null;
          media: Medium[];
        }
        | null;
      replyTarget: Post & { actor: Actor; media: Medium[] } | null;
      media: Medium[];
    })[];
    if (ctx.state.account == null) {
      const languages = new Set<string>(
        acceptsLanguages(ctx.req)
          .filter((lang) => lang !== "*")
          .map((lang) => lang.replace(/-.*$/, "")),
      );
      timeline = await db.query.postTable.findMany({
        with: {
          actor: true,
          sharedPost: {
            with: {
              actor: true,
              replyTarget: {
                with: { actor: true, media: true },
              },
              media: true,
            },
          },
          replyTarget: {
            with: { actor: true, media: true },
          },
          media: true,
        },
        where: and(
          eq(postTable.visibility, "public"),
          languages.size < 1
            ? undefined
            : inArray(postTable.language, [...languages]),
        ),
        orderBy: desc(postTable.published),
      });
    } else {
      timeline = await db.query.postTable.findMany({
        with: {
          actor: true,
          sharedPost: {
            with: {
              actor: true,
              replyTarget: {
                with: { actor: true, media: true },
              },
              media: true,
            },
          },
          replyTarget: {
            with: { actor: true, media: true },
          },
          media: true,
        },
        where: and(
          or(
            inArray(
              postTable.actorId,
              db.select({ id: followingTable.followeeId })
                .from(followingTable)
                .where(
                  eq(followingTable.followerId, ctx.state.account.actor.id),
                ),
            ),
            inArray(
              postTable.id,
              db.select({ postId: mentionTable.postId })
                .from(mentionTable)
                .where(eq(mentionTable.actorId, ctx.state.account.actor.id)),
            ),
            eq(postTable.actorId, ctx.state.account.actor.id),
          ),
          ne(postTable.visibility, "none"),
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
  timeline: (Post & {
    actor: Actor;
    sharedPost:
      | Post & {
        actor: Actor;
        replyTarget: Post & { actor: Actor; media: Medium[] } | null;
        media: Medium[];
      }
      | null;
    replyTarget: Post & { actor: Actor; media: Medium[] } | null;
    media: Medium[];
  })[];
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
                onPost="reload"
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
            {data.timeline.map((post) => (
              <PostExcerpt post={post} signedIn={state.account != null} />
            ))}
          </>
        )}
      </Translation>
    );
  },
);
