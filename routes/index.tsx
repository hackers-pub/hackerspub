import { getLogger } from "@logtape/logtape";
import { acceptsLanguages } from "@std/http/negotiation";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { page } from "fresh";
import { Msg } from "../components/Msg.tsx";
import { PageTitle } from "../components/PageTitle.tsx";
import { PostExcerpt } from "../components/PostExcerpt.tsx";
import { PostPagination } from "../components/PostPagination.tsx";
import {
  TimelineNav,
  type TimelineNavItem,
} from "../components/TimelineNav.tsx";
import { db } from "../db.ts";
import { Composer } from "../islands/Composer.tsx";
import { RecommendedActors } from "../islands/RecommendedActors.tsx";
import { recommendActors } from "../models/actor.ts";
import { extractMentionsFromHtml } from "../models/markup.ts";
import {
  type Account,
  type Actor,
  type Following,
  followingTable,
  type Mention,
  mentionTable,
  type Post,
  type PostMedium,
  postTable,
} from "../models/schema.ts";
import { define } from "../utils.ts";

const logger = getLogger(["hackerspub", "routes", "index"]);

const DEFAULT_WINDOW = 50;

export const handler = define.handlers({
  async GET(ctx) {
    const filterString = ctx.url.searchParams.get("filter");
    let filter: TimelineNavItem;
    if (
      filterString === "local" || filterString === "withoutShares" ||
      ctx.state.account != null &&
        (filterString === "mentions" || filterString === "recommendations")
    ) {
      filter = filterString;
    } else {
      filter = "fediverse";
    }
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
          replyTarget:
            | Post & {
              actor: Actor & { followers: Following[] };
              mentions: (Mention & { actor: Actor })[];
              media: PostMedium[];
            }
            | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
          shares: Post[];
        }
        | null;
      replyTarget:
        | Post & {
          actor: Actor & { followers: Following[] };
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
        }
        | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
    })[];
    const languages = new Set<string>(
      acceptsLanguages(ctx.req)
        .filter((lang) => lang !== "*")
        .map((lang) => lang.replace(/-.*$/, "")),
    );
    logger.debug("Accepted languages: {languages}", { languages });
    if (ctx.state.account == null) {
      timeline = await db.query.postTable.findMany({
        with: {
          actor: true,
          sharedPost: {
            with: {
              actor: true,
              replyTarget: {
                with: {
                  actor: {
                    with: {
                      followers: { where: sql`false` },
                    },
                  },
                  mentions: {
                    with: { actor: true },
                  },
                  media: true,
                },
              },
              mentions: {
                with: { actor: true },
              },
              media: true,
              shares: { where: sql`false` },
            },
          },
          replyTarget: {
            with: {
              actor: {
                with: {
                  followers: { where: sql`false` },
                },
              },
              mentions: {
                with: { actor: true },
              },
              media: true,
            },
          },
          mentions: {
            with: { actor: true },
          },
          media: true,
          shares: { where: sql`false` },
        },
        where: and(
          eq(postTable.visibility, "public"),
          languages.size < 1
            ? undefined
            : inArray(postTable.language, [...languages]),
          isNull(postTable.replyTargetId),
          filter === "local"
            ? or(
              isNotNull(postTable.noteSourceId),
              isNotNull(postTable.articleSourceId),
              inArray(
                postTable.sharedPostId,
                db.select({ id: postTable.id })
                  .from(postTable)
                  .where(
                    or(
                      isNotNull(postTable.noteSourceId),
                      isNotNull(postTable.articleSourceId),
                    ),
                  ),
              ),
            )
            : filter === "withoutShares"
            ? isNull(postTable.sharedPostId)
            : sql`true`,
          until == null ? undefined : lte(postTable.published, until),
        ),
        orderBy: desc(postTable.published),
        limit: window + 1,
      });
    } else {
      timeline = filter === "recommendations"
        ? []
        : await db.query.postTable.findMany({
          with: {
            actor: true,
            sharedPost: {
              with: {
                actor: true,
                replyTarget: {
                  with: {
                    actor: {
                      with: {
                        followers: {
                          where: eq(
                            followingTable.followerId,
                            ctx.state.account.actor.id,
                          ),
                        },
                      },
                    },
                    mentions: {
                      with: { actor: true },
                    },
                    media: true,
                  },
                },
                mentions: {
                  with: { actor: true },
                },
                media: true,
                shares: {
                  where: eq(postTable.actorId, ctx.state.account.actor.id),
                },
              },
            },
            replyTarget: {
              with: {
                actor: {
                  with: {
                    followers: {
                      where: eq(
                        followingTable.followerId,
                        ctx.state.account.actor.id,
                      ),
                    },
                  },
                },
                mentions: {
                  with: { actor: true },
                },
                media: true,
              },
            },
            mentions: {
              with: { actor: true },
            },
            media: true,
            shares: {
              where: eq(postTable.actorId, ctx.state.account.actor.id),
            },
          },
          where: and(
            or(
              filter === "mentions" ? sql`false` : or(
                and(
                  inArray(
                    postTable.actorId,
                    db.select({ id: followingTable.followeeId })
                      .from(followingTable)
                      .where(
                        eq(
                          followingTable.followerId,
                          ctx.state.account.actor.id,
                        ),
                      ),
                  ),
                  ne(postTable.visibility, "direct"),
                  or(
                    isNull(postTable.replyTargetId),
                    inArray(
                      postTable.replyTargetId,
                      db.select({ id: postTable.id })
                        .from(postTable)
                        .where(
                          or(
                            eq(postTable.actorId, ctx.state.account.actor.id),
                            inArray(
                              postTable.actorId,
                              db.select({ id: followingTable.followeeId })
                                .from(followingTable)
                                .where(
                                  eq(
                                    followingTable.followerId,
                                    ctx.state.account.actor.id,
                                  ),
                                ),
                            ),
                          ),
                        ),
                    ),
                  ),
                ),
                eq(postTable.actorId, ctx.state.account.actor.id),
              ),
              inArray(
                postTable.id,
                db.select({ postId: mentionTable.postId })
                  .from(mentionTable)
                  .where(eq(mentionTable.actorId, ctx.state.account.actor.id)),
              ),
            ),
            ne(postTable.visibility, "none"),
            filter === "local"
              ? or(
                isNotNull(postTable.noteSourceId),
                isNotNull(postTable.articleSourceId),
                inArray(
                  postTable.sharedPostId,
                  db.select({ id: postTable.id })
                    .from(postTable)
                    .where(
                      or(
                        isNotNull(postTable.noteSourceId),
                        isNotNull(postTable.articleSourceId),
                      ),
                    ),
                ),
              )
              : filter === "withoutShares"
              ? isNull(postTable.sharedPostId)
              : sql`true`,
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
    const acceptedLanguages = acceptsLanguages(ctx.req);
    const recommendedActors = next == null || filter === "recommendations"
      ? await recommendActors(db, {
        mainLanguage:
          acceptedLanguages.length > 0 && acceptedLanguages[0] !== "*"
            ? acceptedLanguages[0]
            : undefined,
        languages: [...languages],
        account: ctx.state.account,
        limit: 50,
      })
      : [];
    logger.debug("Recommended actors: {recommendedActors}", {
      recommendedActors,
    });
    const recommendedActorMentions = await extractMentionsFromHtml(
      db,
      ctx.state.fedCtx,
      recommendedActors.map((actor) => actor.bioHtml).join("\n"),
      ctx.state.account == null ? {} : {
        documentLoader: await ctx.state.fedCtx.getDocumentLoader(
          ctx.state.account,
        ),
      },
    );
    ctx.state.metas.push(
      { name: "description", content: ctx.state.t("home.intro.content") },
      { property: "og:title", content: "Hackers' Pub" },
      {
        property: "og:description",
        content: ctx.state.t("home.intro.content"),
      },
      {
        property: "og:url",
        content: new URL("/", ctx.state.canonicalOrigin).href,
      },
      { property: "og:type", content: "website" },
      {
        property: "og:image",
        content: new URL("/og.png", ctx.state.canonicalOrigin).href,
      },
      { property: "og:image:width", content: 1200 },
      { property: "og:image:height", content: 630 },
    );
    ctx.state.links.push(
      { rel: "canonical", href: new URL("/", ctx.state.canonicalOrigin).href },
    );
    return page<HomeProps>({
      intro: filter !== "recommendations" &&
        (ctx.state.account == null || timeline.length < 1),
      composer: ctx.state.account != null,
      filter,
      timeline,
      next,
      window,
      recommendedActors,
      recommendedActorMentions,
    });
  },
});

interface HomeProps {
  intro: boolean;
  composer: boolean;
  filter: TimelineNavItem;
  timeline: (Post & {
    actor: Actor;
    sharedPost:
      | Post & {
        actor: Actor;
        replyTarget:
          | Post & {
            actor: Actor & { followers: Following[] };
            mentions: (Mention & { actor: Actor })[];
            media: PostMedium[];
          }
          | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
        shares: Post[];
      }
      | null;
    replyTarget:
      | Post & {
        actor: Actor & { followers: Following[] };
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
      }
      | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
  })[];
  next?: Date;
  window: number;
  recommendedActors: (Actor & { account?: Account | null })[];
  recommendedActorMentions: { actor: Actor }[];
}

export default define.page<typeof handler, HomeProps>(
  function Home({ url, state, data }) {
    const nextHref = data.next == null
      ? undefined
      : data.window === DEFAULT_WINDOW
      ? `?filter=${data.filter}&until=${+data.next}`
      : `?filter=${data.filter}&until=${+data.next}&window=${data.window}`;
    return (
      <>
        {data.composer && (
          <Composer
            language={state.language}
            postUrl={`/@${state.account!.username}`}
            previewUrl={new URL("/api/preview", url).href}
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
        <TimelineNav active={data.filter} signedIn={state.account != null} />
        {data.filter !== "recommendations" && (
          <>
            {data.timeline.map((post) => (
              <PostExcerpt post={post} signedAccount={state.account} />
            ))}
            <PostPagination nextHref={nextHref} />
          </>
        )}
        {data.recommendedActors.length > 0 && (
          <RecommendedActors
            language={state.language}
            actors={data.recommendedActors}
            actorMentions={data.recommendedActorMentions}
            window={6}
            title={data.filter !== "recommendations"}
            class={data.filter === "recommendations" ? "mt-4" : ""}
          />
        )}
      </>
    );
  },
);
