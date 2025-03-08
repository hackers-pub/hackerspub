import { acceptsLanguages } from "@std/http/negotiation";
import { and, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import { page } from "fresh";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { PostExcerpt } from "../components/PostExcerpt.tsx";
import { PostPagination } from "../components/PostPagination.tsx";
import { db } from "../db.ts";
import { Composer } from "../islands/Composer.tsx";
import {
  type Actor,
  followingTable,
  mentionTable,
  type Post,
  type PostMedium,
  postTable,
} from "../models/schema.ts";
import { define } from "../utils.ts";

const DEFAULT_WINDOW = 50;

export const handler = define.handlers({
  async GET(ctx) {
    const untilString = ctx.url.searchParams.get("until");
    const until = untilString == null || !untilString.match(/^\d+(\.\d+)?$/)
      ? undefined
      : new Date(parseInt(untilString));
    const windowString = ctx.url.searchParams.get("window");
    const window = windowString == null || !windowString.match(/^\d+$/)
      ? DEFAULT_WINDOW
      : parseInt(windowString);
    let timeline: (Post & {
      actor: Actor;
      sharedPost:
        | Post & {
          actor: Actor;
          replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
          media: PostMedium[];
          shares: Post[];
        }
        | null;
      replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
      media: PostMedium[];
      shares: Post[];
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
              shares: { where: sql`false` },
            },
          },
          replyTarget: {
            with: { actor: true, media: true },
          },
          media: true,
          shares: { where: sql`false` },
        },
        where: and(
          eq(postTable.visibility, "public"),
          languages.size < 1
            ? undefined
            : inArray(postTable.language, [...languages]),
          until == null ? undefined : lte(postTable.published, until),
        ),
        orderBy: desc(postTable.published),
        limit: window + 1,
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
              shares: {
                where: eq(postTable.actorId, ctx.state.account.actor.id),
              },
            },
          },
          replyTarget: {
            with: { actor: true, media: true },
          },
          media: true,
          shares: {
            where: eq(postTable.actorId, ctx.state.account.actor.id),
          },
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
          until == null ? undefined : lte(postTable.published, until),
        ),
        orderBy: desc(postTable.published),
        limit: window + 1,
      });
    }
    let next: Date | undefined = undefined;
    if (timeline.length > window) {
      next = timeline[window].published;
      timeline = timeline.slice(0, window);
    }
    return page<HomeProps>({
      intro: ctx.state.account == null || timeline.length < 1,
      composer: ctx.state.account != null,
      timeline,
      next,
      window,
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
        replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
        media: PostMedium[];
        shares: Post[];
      }
      | null;
    replyTarget: Post & { actor: Actor; media: PostMedium[] } | null;
    media: PostMedium[];
    shares: Post[];
  })[];
  next?: Date;
  window: number;
}

export default define.page<typeof handler, HomeProps>(
  function Home({ state, data }) {
    const nextHref = data.next == null
      ? undefined
      : data.window === DEFAULT_WINDOW
      ? `?until=${+data.next}`
      : `?until=${+data.next}&window=${data.window}`;
    return (
      <>
        {data.composer && (
          <Composer
            language={state.language}
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
          <PostExcerpt post={post} signedAccount={state.account} />
        ))}
        <PostPagination nextHref={nextHref} />
      </>
    );
  },
);
