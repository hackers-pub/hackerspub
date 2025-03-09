import { isActor } from "@fedify/fedify";
import type * as vocab from "@fedify/fedify/vocab";
import { getLogger } from "@logtape/logtape";
import * as v from "@valibot/valibot";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { page } from "fresh";
import { PostExcerpt } from "../../components/PostExcerpt.tsx";
import { PostPagination } from "../../components/PostPagination.tsx";
import { Profile } from "../../components/Profile.tsx";
import { ProfileNav } from "../../components/ProfileNav.tsx";
import { db } from "../../db.ts";
import { drive } from "../../drive.ts";
import { POSSIBLE_LANGUAGES } from "../../i18n.ts";
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
import { renderMarkup } from "../../models/markup.ts";
import { createNote } from "../../models/note.ts";
import {
  type AccountLink,
  type Actor,
  actorTable,
  type Post,
  POST_VISIBILITIES,
  type PostMedium,
  postTable,
} from "../../models/schema.ts";
import { define } from "../../utils.ts";

const logger = getLogger(["hackerspub", "routes", "@[username]"]);

const DEFAULT_WINDOW = 50;

export const NoteSourceSchema = v.objectAsync({
  content: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  language: v.picklist(POSSIBLE_LANGUAGES),
  visibility: v.picklist(POST_VISIBILITIES),
  replyTargetId: v.optional(v.pipe(v.string(), v.uuid())),
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
        where: and(
          eq(actorTable.username, username),
          eq(actorTable.instanceHost, host),
        ),
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
        actor = await persistActor(db, apActor);
        if (actor == null) return ctx.next();
      }
      if (ctx.state.session == null) {
        return ctx.redirect(actor.url ?? actor.iri);
      }
      const handle = `@${actor.username}@${actor.instanceHost}`;
      const followingState = ctx.state.account == null
        ? undefined
        : await getFollowingState(db, ctx.state.account.actor, actor);
      const followedState = ctx.state.account == null
        ? undefined
        : await getFollowingState(db, actor, ctx.state.account.actor);
      const posts = await db.query.postTable.findMany({
        with: {
          actor: true,
          sharedPost: {
            with: {
              actor: true,
              replyTarget: { with: { actor: true, media: true } },
              media: true,
              shares: {
                where: ctx.state.account == null
                  ? sql`false`
                  : eq(postTable.actorId, ctx.state.account.actor.id),
              },
            },
          },
          replyTarget: { with: { actor: true, media: true } },
          media: true,
          shares: {
            where: ctx.state.account == null
              ? sql`false`
              : eq(postTable.actorId, ctx.state.account.actor.id),
          },
        },
        where: and(
          eq(postTable.actorId, actor.id),
          inArray(postTable.visibility, ["public", "unlisted"]), // FIXME
          until == null ? undefined : lte(postTable.published, until),
        ),
        orderBy: desc(postTable.published),
        limit: window + 1,
      });
      ctx.state.title = actor.name ?? handle;
      ctx.state.searchQuery = handle;
      const next = posts.length > window ? posts[window].published : undefined;
      return page<ProfilePageProps>({
        profileHref: `/${handle}`,
        actor,
        followingState,
        followedState,
        stats: await getActorStats(db, actor.id),
        posts: posts.slice(0, window),
        nextHref: next == null
          ? undefined
          : window === DEFAULT_WINDOW
          ? `/${handle}?until=${+next}`
          : `/${handle}?until=${+next}&window=${window}`,
      });
    }
    const account = await getAccountByUsername(db, ctx.params.username);
    if (account == null) return ctx.next();
    if (account.username !== ctx.params.username) {
      return ctx.redirect(`/@${account.username}`, 301);
    }
    const bio = await renderMarkup(
      db,
      ctx.state.fedCtx,
      account.id,
      account.bio,
    );
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
    );
    ctx.state.title = account.name;
    ctx.state.searchQuery = `@${account.username}`;
    const posts = await db.query.postTable.findMany({
      with: {
        actor: true,
        sharedPost: {
          with: {
            actor: true,
            replyTarget: { with: { actor: true, media: true } },
            media: true,
            shares: {
              where: ctx.state.account == null
                ? sql`false`
                : eq(postTable.actorId, ctx.state.account.actor.id),
            },
          },
        },
        replyTarget: { with: { actor: true, media: true } },
        media: true,
        shares: {
          where: ctx.state.account == null
            ? sql`false`
            : eq(postTable.actorId, ctx.state.account.actor.id),
        },
      },
      where: and(
        eq(postTable.actorId, account.actor.id),
        inArray(postTable.visibility, ["public", "unlisted"]), // FIXME
        until == null ? undefined : lte(postTable.published, until),
      ),
      orderBy: desc(postTable.published),
      limit: window + 1,
    });
    const followingState = ctx.state.account == null
      ? undefined
      : await getFollowingState(db, ctx.state.account.actor, account.actor);
    const followedState = ctx.state.account == null
      ? undefined
      : await getFollowingState(db, account.actor, ctx.state.account.actor);
    const next = posts.length > window ? posts[window].published : undefined;
    return page<ProfilePageProps>({
      profileHref: permalink.href,
      actor: account.actor,
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
    const post = await createNote(db, kv, disk, ctx.state.fedCtx, {
      ...parsed.output,
      accountId: ctx.state.account.id,
    });
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
  actor: Actor;
  followingState?: FollowingState;
  followedState?: FollowingState;
  links?: AccountLink[];
  stats: ActorStats;
  posts: (Post & {
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
  nextHref?: string;
}

export default define.page<typeof handler, ProfilePageProps>(
  function ProfilePage({ state, data }) {
    return (
      <div>
        <Profile
          actor={data.actor}
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
