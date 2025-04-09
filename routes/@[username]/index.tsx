import { isActor } from "@fedify/fedify";
import type * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import * as v from "@valibot/valibot";
import { sql } from "drizzle-orm";
import { page } from "fresh";
import { PostExcerpt } from "../../components/PostExcerpt.tsx";
import { PostPagination } from "../../components/PostPagination.tsx";
import { Profile } from "../../components/Profile.tsx";
import { ProfileNav } from "../../components/ProfileNav.tsx";
import { db } from "../../db.ts";
import { drive } from "../../drive.ts";
import { POSSIBLE_LOCALES } from "../../i18n.ts";
import { kv } from "../../kv.ts";
import { getAccountByUsername } from "../../models/account.ts";
import {
  type ActorStats,
  getActorStats,
  persistActor,
} from "../../models/actor.ts";
import {
  type FollowingState,
  getFollowingState,
} from "../../models/following.ts";
import { extractMentionsFromHtml, renderMarkup } from "../../models/markup.ts";
import { createNote } from "../../models/note.ts";
import { getPostVisibilityFilter } from "../../models/post.ts";
import {
  type AccountLink,
  type Actor,
  type Following,
  type Instance,
  type Mention,
  type Post,
  POST_VISIBILITIES,
  type PostLink,
  type PostMedium,
  type Reaction,
} from "../../models/schema.ts";
import type { Uuid } from "../../models/uuid.ts";
import { define } from "../../utils.ts";

const logger = getLogger(["hackerspub", "routes", "@[username]"]);

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
    if (ctx.params.username.includes("@")) {
      const username = ctx.params.username.replace(/@.*$/, "");
      const host = ctx.params.username.substring(
        ctx.params.username.indexOf("@") + 1,
      );
      let actor = await db.query.actorTable.findFirst({
        with: { successor: true },
        where: {
          username,
          OR: [
            { instanceHost: host },
            { handleHost: host },
          ],
        },
      });
      if (
        ctx.state.account?.moderator && ctx.url.searchParams.has("refresh") ||
        actor == null
      ) {
        let apActor: vocab.Object | null;
        try {
          apActor = await ctx.state.fedCtx.lookupObject(
            ctx.params.username,
            {
              documentLoader: ctx.state.account == null
                ? undefined
                : await ctx.state.fedCtx.getDocumentLoader({
                  identifier: ctx.state.account.id,
                }),
            },
          );
        } catch (error) {
          logger.warn(
            "An error occurred while looking up the actor {handle}: {error}",
            { handle: ctx.params.username, error },
          );
          return ctx.next();
        }
        if (!isActor(apActor)) return ctx.next();
        actor = await persistActor(db, ctx.state.fedCtx, apActor);
        if (actor == null) return ctx.next();
      }
      if (ctx.state.session == null) {
        return ctx.redirect(actor.url ?? actor.iri);
      }
      const followingState =
        ctx.state.account == null || ctx.state.account.actor.id === actor.id
          ? undefined
          : await getFollowingState(db, ctx.state.account.actor, actor);
      const followedState =
        ctx.state.account == null || ctx.state.account.actor.id === actor.id
          ? undefined
          : await getFollowingState(db, actor, ctx.state.account.actor);
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
      ctx.state.title = actor.name ?? actor.handle;
      ctx.state.searchQuery = actor.handle;
      const next = posts.length > window ? posts[window].published : undefined;
      return page<ProfilePageProps>({
        profileHref: `/${actor.handle}`,
        actor,
        actorMentions: await extractMentionsFromHtml(
          db,
          ctx.state.fedCtx,
          actor.bioHtml ?? "",
          { kv },
        ),
        followingState,
        followedState,
        stats: await getActorStats(db, actor.id),
        posts: posts.slice(0, window),
        nextHref: next == null
          ? undefined
          : window === DEFAULT_WINDOW
          ? `/${actor.handle}?until=${+next}`
          : `/${actor.handle}?until=${+next}&window=${window}`,
      });
    }
    const account = await getAccountByUsername(db, ctx.params.username);
    if (account == null) return ctx.next();
    if (account.username !== ctx.params.username) {
      return ctx.redirect(`/@${account.username}`, 301);
    }
    const bio = await renderMarkup(db, ctx.state.fedCtx, account.bio, {
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
        content: new URL(`/@${account.username}/og`, ctx.state.canonicalOrigin),
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
          { actorId: account.actor.id, published: { lte: until } },
          getPostVisibilityFilter(ctx.state.account?.actor ?? null),
        ],
      },
      orderBy: { published: "desc" },
      limit: window + 1,
    });
    const followingState =
      ctx.state.account == null || ctx.state.account.id === account.id
        ? undefined
        : await getFollowingState(db, ctx.state.account.actor, account.actor);
    const followedState =
      ctx.state.account == null || ctx.state.account.id === account.id
        ? undefined
        : await getFollowingState(db, account.actor, ctx.state.account.actor);
    const next = posts.length > window ? posts[window].published : undefined;
    return page<ProfilePageProps>({
      profileHref: permalink.href,
      actor: account.actor,
      actorMentions: await extractMentionsFromHtml(
        db,
        ctx.state.fedCtx,
        account.actor.bioHtml ?? "",
        {
          documentLoader: await ctx.state.fedCtx.getDocumentLoader(account),
          kv,
        },
      ),
      links: account.links,
      followingState,
      followedState,
      stats: await getActorStats(db, account.actor.id),
      posts: posts.slice(0, window),
      nextHref: next == null
        ? undefined
        : window === DEFAULT_WINDOW
        ? `/@${account.username}?until=${+next}`
        : `/@${account.username}?until=${+next}&window=${window}`,
    }, {
      headers: {
        Link:
          `<${actorUri.href}>; rel="alternate"; type="application/activity+json"`,
      },
    });
  },

  async POST(ctx) {
    if (ctx.state.account?.username !== ctx.params.username) {
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
    const disk = drive.use();
    const quotedPost = parsed.output.quotedPostId == null
      ? undefined
      : await db.query.postTable.findFirst({
        where: {
          id: parsed.output.quotedPostId as Uuid,
          visibility: { in: ["public", "unlisted"] },
        },
        with: { actor: true },
      });
    const post = await createNote(db, kv, disk, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    }, { quotedPost });
    if (post == null) {
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response(JSON.stringify(post), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  },
});

interface ProfilePageProps {
  profileHref: string;
  actor: Actor & { successor: Actor | null };
  actorMentions: { actor: Actor }[];
  followingState?: FollowingState;
  followedState?: FollowingState;
  links?: AccountLink[];
  stats: ActorStats;
  posts: (Post & {
    actor: Actor & { instance: Instance };
    link: PostLink & { creator?: Actor | null } | null;
    sharedPost:
      | Post & {
        actor: Actor & { instance: Instance };
        link: PostLink & { creator?: Actor | null } | null;
        replyTarget:
          | Post & {
            actor: Actor & { instance: Instance; followers: Following[] };
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
        actor: Actor & { instance: Instance; followers: Following[] };
        link: PostLink & { creator?: Actor | null } | null;
        mentions: (Mention & { actor: Actor })[];
        media: PostMedium[];
      }
      | null;
    mentions: (Mention & { actor: Actor })[];
    media: PostMedium[];
    shares: Post[];
    reactions: Reaction[];
  })[];
  nextHref?: string;
}

export default define.page<typeof handler, ProfilePageProps>(
  function ProfilePage({ state, data }) {
    return (
      <div>
        <Profile
          actor={data.actor}
          actorMentions={data.actorMentions}
          followingState={data.followingState}
          followedState={data.followedState}
          links={data.links}
          profileHref={data.profileHref}
        />
        <ProfileNav
          active="total"
          stats={data.stats}
          profileHref={data.profileHref}
        />
        <div>
          {data.posts.map((post) => (
            <PostExcerpt post={post} signedAccount={state.account} />
          ))}
          <PostPagination nextHref={data.nextHref} />
        </div>
      </div>
    );
  },
);
