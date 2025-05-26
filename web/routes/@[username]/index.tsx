import { isActor } from "@fedify/fedify";
import { page } from "@fresh/core";
import { getRelationship, type Relationship } from "@hackerspub/models/account";
import {
  type ActorStats,
  getActorStats,
  persistActor,
} from "@hackerspub/models/actor";
import { POSSIBLE_LOCALES } from "@hackerspub/models/i18n";
import {
  extractMentionsFromHtml,
  renderMarkup,
} from "@hackerspub/models/markup";
import { createNote } from "@hackerspub/models/note";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import {
  type Account,
  type AccountLink,
  type Actor,
  type Blocking,
  type Following,
  type Instance,
  type Mention,
  type Pin,
  type Post,
  POST_VISIBILITIES,
  type PostLink,
  type PostMedium,
  type Reaction,
} from "@hackerspub/models/schema";
import { withTransaction } from "@hackerspub/models/tx";
import type { Uuid } from "@hackerspub/models/uuid";
import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { Msg } from "../../components/Msg.tsx";
import { PostExcerpt } from "../../components/PostExcerpt.tsx";
import { PostPagination } from "../../components/PostPagination.tsx";
import { Profile } from "../../components/Profile.tsx";
import { ProfileNav } from "../../components/ProfileNav.tsx";
import { db } from "../../db.ts";
import { kv } from "../../kv.ts";
import { define } from "../../utils.ts";

const DEFAULT_WINDOW = 50;

export const NoteSourceSchema = v.objectAsync({
  content: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  language: v.picklist(POSSIBLE_LOCALES),
  visibility: v.picklist(POST_VISIBILITIES),
  media: v.arrayAsync(
    v.pipeAsync(
      v.objectAsync({
        url: v.pipeAsync(
          v.string(),
          v.startsWith("data:"),
          v.url(),
          v.transformAsync<string, Blob>((url) =>
            fetch(url).then((r) => r.blob())
          ),
        ),
        alt: v.pipe(v.string(), v.trim(), v.nonEmpty()),
      }),
      v.transform((pair) => ({ alt: pair.alt, blob: pair.url })),
    ),
  ),
  quotedPostId: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
});

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
      return Response.redirect(
        new URL(`/@${ctx.params.username.replace(/@.*$/, "")}`, ctx.url),
        301,
      );
    }
    const untilString = ctx.url.searchParams.get("until");
    const until = untilString == null || !untilString.match(/^\d+(\.\d+)?$/)
      ? undefined
      : new Date(parseInt(untilString));
    const windowString = ctx.url.searchParams.get("window");
    const window = windowString == null || !windowString.match(/^\d+$/)
      ? DEFAULT_WINDOW
      : parseInt(windowString);
    let account: Account | undefined;
    let actor: Actor & { successor: Actor | null } | undefined;
    let links: AccountLink[] | undefined;
    if (ctx.params.username.includes("@")) {
      if (ctx.url.searchParams.has("refresh") && ctx.state.account?.moderator) {
        const documentLoader = ctx.state.account == null
          ? undefined
          : await ctx.state.fedCtx.getDocumentLoader({
            identifier: ctx.state.account.id,
          });
        const actorObject = await ctx.state.fedCtx.lookupObject(
          ctx.params.username,
          { documentLoader },
        );
        if (!isActor(actorObject)) return ctx.next();
        actor = await persistActor(ctx.state.fedCtx, actorObject, {
          documentLoader,
        });
      }
      if (actor == null) {
        const username = ctx.params.username.replace(/@.*$/, "");
        const host = ctx.params.username.substring(
          ctx.params.username.indexOf("@") + 1,
        );
        actor = await db.query.actorTable.findFirst({
          with: { successor: true },
          where: {
            username,
            OR: [
              { instanceHost: host },
              { handleHost: host },
            ],
          },
        });
      }
      if (actor == null) return ctx.next();
      ctx.state.title = actor.name ?? actor.username;
      ctx.state.searchQuery = actor.handle;
    } else {
      const acct = await db.query.accountTable.findFirst({
        with: { actor: { with: { successor: true } }, links: true },
        where: { username: ctx.params.username },
      });
      if (acct == null) return ctx.next();
      account = acct;
      actor = acct.actor;
      links = acct.links;
      const bio = await renderMarkup(ctx.state.fedCtx, account.bio, {
        docId: account.id,
        kv,
      });
      const permalink = new URL(
        `/@${account.username}`,
        ctx.state.canonicalOrigin,
      );
      ctx.state.metas.push(
        {
          name: "description",
          content: bio.text,
        },
        { property: "og:title", content: account.name },
        {
          property: "og:description",
          content: bio.text,
        },
        { property: "og:url", content: permalink },
        { property: "og:type", content: "profile" },
        {
          property: "og:image",
          content: new URL(
            `/@${account.username}/og`,
            ctx.state.canonicalOrigin,
          ),
        },
        { property: "og:image:width", content: 1200 },
        { property: "og:image:height", content: 630 },
        { property: "profile:username", content: account.username },
      );
      const actorUri = ctx.state.fedCtx.getActorUri(account.id);
      ctx.state.links.push(
        { rel: "canonical", href: permalink },
        {
          rel: "alternate",
          type: "application/activity+json",
          href: actorUri,
        },
        {
          rel: "alternate",
          type: "application/atom+xml",
          href: new URL(
            `/@${account.username}/feed.xml`,
            ctx.state.canonicalOrigin,
          ),
          title: ctx.state.t("profile.feed"),
        },
        {
          rel: "alternate",
          type: "application/atom+xml",
          href: new URL(
            `/@${account.username}/feed.xml?articles`,
            ctx.state.canonicalOrigin,
          ),
          title: ctx.state.t("profile.articlesFeed"),
        },
      );
      ctx.state.title = account.name;
      ctx.state.searchQuery = `@${account.username}`;
    }
    const stats = await getActorStats(db, actor.id);
    const posts = await db.query.postTable.findMany({
      with: {
        actor: { with: { instance: true } },
        link: { with: { creator: true } },
        sharedPost: {
          with: {
            actor: { with: { instance: true } },
            link: { with: { creator: true } },
            replyTarget: {
              with: {
                actor: {
                  with: {
                    instance: true,
                    followers: {
                      where: ctx.state.account == null
                        ? { RAW: sql`false` }
                        : { followerId: ctx.state.account.actor.id },
                    },
                    blockees: {
                      where: ctx.state.account == null
                        ? { RAW: sql`false` }
                        : { blockeeId: ctx.state.account.actor.id },
                    },
                    blockers: {
                      where: ctx.state.account == null
                        ? { RAW: sql`false` }
                        : { blockerId: ctx.state.account.actor.id },
                    },
                  },
                },
                link: { with: { creator: true } },
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
              where: ctx.state.account == null
                ? { RAW: sql`false` }
                : { actorId: ctx.state.account.actor.id },
            },
            reactions: {
              where: ctx.state.account == null
                ? { RAW: sql`false` }
                : { actorId: ctx.state.account.actor.id },
            },
          },
        },
        replyTarget: {
          with: {
            actor: {
              with: {
                instance: true,
                followers: {
                  where: ctx.state.account == null
                    ? { RAW: sql`false` }
                    : { followerId: ctx.state.account.actor.id },
                },
                blockees: {
                  where: ctx.state.account == null
                    ? { RAW: sql`false` }
                    : { blockeeId: ctx.state.account.actor.id },
                },
                blockers: {
                  where: ctx.state.account == null
                    ? { RAW: sql`false` }
                    : { blockerId: ctx.state.account.actor.id },
                },
              },
            },
            link: { with: { creator: true } },
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
          where: ctx.state.account == null
            ? { RAW: sql`false` }
            : { actorId: ctx.state.account.actor.id },
        },
        reactions: {
          where: ctx.state.account == null
            ? { RAW: sql`false` }
            : { actorId: ctx.state.account.actor.id },
        },
      },
      where: {
        AND: [
          { actorId: actor.id, published: { lte: until } },
          getPostVisibilityFilter(ctx.state.account?.actor ?? null),
        ],
      },
      orderBy: { published: "desc" },
      limit: window + 1,
    });
    const pins: (Pin & { post: EnrichedPost })[] = until == null
      ? await db.query.pinTable.findMany({
        with: {
          post: {
            with: {
              actor: { with: { instance: true } },
              link: { with: { creator: true } },
              sharedPost: {
                with: {
                  actor: { with: { instance: true } },
                  link: { with: { creator: true } },
                  replyTarget: {
                    with: {
                      actor: {
                        with: {
                          instance: true,
                          followers: {
                            where: ctx.state.account == null
                              ? { RAW: sql`false` }
                              : { followerId: ctx.state.account.actor.id },
                          },
                          blockees: {
                            where: ctx.state.account == null
                              ? { RAW: sql`false` }
                              : { blockeeId: ctx.state.account.actor.id },
                          },
                          blockers: {
                            where: ctx.state.account == null
                              ? { RAW: sql`false` }
                              : { blockerId: ctx.state.account.actor.id },
                          },
                        },
                      },
                      link: { with: { creator: true } },
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
                    where: ctx.state.account == null
                      ? { RAW: sql`false` }
                      : { actorId: ctx.state.account.actor.id },
                  },
                  reactions: {
                    where: ctx.state.account == null
                      ? { RAW: sql`false` }
                      : { actorId: ctx.state.account.actor.id },
                  },
                },
              },
              replyTarget: {
                with: {
                  actor: {
                    with: {
                      instance: true,
                      followers: {
                        where: ctx.state.account == null
                          ? { RAW: sql`false` }
                          : { followerId: ctx.state.account.actor.id },
                      },
                      blockees: {
                        where: ctx.state.account == null
                          ? { RAW: sql`false` }
                          : { blockeeId: ctx.state.account.actor.id },
                      },
                      blockers: {
                        where: ctx.state.account == null
                          ? { RAW: sql`false` }
                          : { blockerId: ctx.state.account.actor.id },
                      },
                    },
                  },
                  link: { with: { creator: true } },
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
                where: ctx.state.account == null
                  ? { RAW: sql`false` }
                  : { actorId: ctx.state.account.actor.id },
              },
              reactions: {
                where: ctx.state.account == null
                  ? { RAW: sql`false` }
                  : { actorId: ctx.state.account.actor.id },
              },
            },
          },
        },
        where: {
          actorId: actor.id,
          post: getPostVisibilityFilter(ctx.state.account?.actor ?? null),
        },
        orderBy: { created: "desc" },
      })
      : [];
    const next = posts.length > window ? posts[window].published : undefined;
    return page<ProfilePageProps>({
      profileHref: account == null
        ? `/${actor.handle}`
        : `/@${account.username}`,
      actor,
      actorMentions: await extractMentionsFromHtml(
        ctx.state.fedCtx,
        actor.bioHtml ?? "",
        {
          documentLoader: actor.accountId == null
            ? undefined
            : await ctx.state.fedCtx.getDocumentLoader({
              identifier: actor.accountId,
            }),
          kv,
        },
      ),
      links,
      relationship: await getRelationship(db, ctx.state.account, actor),
      stats,
      posts: posts.slice(0, window),
      pinnedPosts: pins.map((pin) => pin.post),
      nextHref: next == null
        ? undefined
        : window === DEFAULT_WINDOW
        ? `?until=${+next}`
        : `?until=${+next}&window=${window}`,
    }, {
      headers: {
        Link:
          `<${actor.iri}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },

  async POST(ctx) {
    const account = ctx.state.account;
    if (account?.username !== ctx.params.username) {
      return new Response("Forbidden", { status: 403 });
    }
    const payload = await ctx.req.json();
    const parsed = await v.safeParseAsync(NoteSourceSchema, payload);
    if (!parsed.success) {
      return new Response(JSON.stringify(parsed.issues), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const quotedPost = parsed.output.quotedPostId == null
      ? undefined
      : await db.query.postTable.findFirst({
        where: {
          id: parsed.output.quotedPostId as Uuid,
          visibility: { in: ["public", "unlisted"] },
        },
        with: { actor: true },
      });
    return await withTransaction(ctx.state.fedCtx, async (context) => {
      const post = await createNote(context, {
        ...parsed.output,
        accountId: account.id,
      }, { quotedPost });
      if (post == null) {
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response(JSON.stringify(post), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });
  },
});

type EnrichedPost = Post & {
  actor: Actor & { instance: Instance };
  link: PostLink & { creator?: Actor | null } | null;
  sharedPost:
    | Post & {
      actor: Actor & { instance: Instance };
      link: PostLink & { creator?: Actor | null } | null;
      replyTarget:
        | Post & {
          actor: Actor & {
            instance: Instance;
            followers: Following[];
            blockees: Blocking[];
            blockers: Blocking[];
          };
          link: PostLink & { creator?: Actor | null } | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
        }
        | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
      shares: Post[];
      reactions: Reaction[];
    }
    | null;
  replyTarget:
    | Post & {
      actor: Actor & {
        instance: Instance;
        followers: Following[];
        blockees: Blocking[];
        blockers: Blocking[];
      };
      link: PostLink & { creator?: Actor | null } | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
    }
    | null;
  mentions: (Mention & { actor: Actor })[];
  media: PostMedium[];
  shares: Post[];
  reactions: Reaction[];
};

interface ProfilePageProps {
  profileHref: string;
  actor: Actor & { successor: Actor | null };
  actorMentions: { actor: Actor }[];
  relationship: Relationship | null;
  links?: AccountLink[];
  stats: ActorStats;
  posts: EnrichedPost[];
  pinnedPosts: EnrichedPost[];
  nextHref?: string;
}

export default define.page<typeof handler, ProfilePageProps>(
  function ProfilePage({ state, data }) {
    return (
      <div>
        <Profile
          actor={data.actor}
          actorMentions={data.actorMentions}
          relationship={data.relationship}
          links={data.links}
          profileHref={data.profileHref}
        />
        <ProfileNav
          active="total"
          stats={data.stats}
          profileHref={data.profileHref}
        />
        {data.pinnedPosts.length > 0 &&
          (
            <div class="border-b border-stone-300 dark:border-stone-700 pb-4">
              <h2 class="flex flex-row mt-4 items-center opacity-50 font-bold">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 14 14"
                  width="1em"
                  height="1em"
                  class="size-3 stroke-2 mr-1"
                >
                  <path
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M9.73 7.65L13 5.54A1 1 0 0 0 13.21 4L10 .79A1 1 0 0 0 8.46 1L6.3 4.23l-4.49 1a.6.6 0 0 0-.29 1l6.15 6.16a.61.61 0 0 0 1-.3ZM4.59 9.38L.5 13.5"
                  />
                </svg>
                <Msg $key="profile.pinnedPosts" />
              </h2>
              {data.pinnedPosts.map((post) => (
                <PostExcerpt
                  post={post}
                  signedAccount={state.account}
                  noReplyTarget
                />
              ))}
            </div>
          )}
        <div>
          {data.posts.map((post) => (
            <PostExcerpt
              post={post}
              signedAccount={state.account}
            />
          ))}
          <PostPagination nextHref={data.nextHref} />
        </div>
      </div>
    );
  },
);
