import { sql } from "drizzle-orm";
import { page } from "fresh";
import { PostExcerpt } from "../../components/PostExcerpt.tsx";
import { PostPagination } from "../../components/PostPagination.tsx";
import { Profile } from "../../components/Profile.tsx";
import { ProfileNav } from "../../components/ProfileNav.tsx";
import { db } from "../../db.ts";
import { kv } from "../../kv.ts";
import { type ActorStats, getActorStats } from "../../models/actor.ts";
import {
  type FollowingState,
  getFollowingState,
} from "../../models/following.ts";
import { extractMentionsFromHtml } from "../../models/markup.ts";
import type {
  Account,
  AccountLink,
  Actor,
  Following,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
} from "../../models/schema.ts";
import { define } from "../../utils.ts";

const DEFAULT_WINDOW = 50;

export const handler = define.handlers({
  async GET(ctx) {
    if (ctx.params.username.endsWith(`@${ctx.url.host}`)) {
      return Response.redirect(
        new URL(`/@${ctx.params.username.replace(/@.*$/, "")}/notes`, ctx.url),
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
      if (actor == null) return ctx.next();
    } else {
      const acct = await db.query.accountTable.findFirst({
        with: { actor: { with: { successor: true } }, links: true },
        where: { username: ctx.params.username },
      });
      if (acct == null) return ctx.next();
      account = acct;
      actor = acct.actor;
      links = acct.links;
    }
    const followingState =
      ctx.state.account == null || ctx.state.account.actor.id === actor.id
        ? undefined
        : await getFollowingState(db, ctx.state.account.actor, actor);
    const followedState =
      ctx.state.account == null || ctx.state.account.actor.id === actor.id
        ? undefined
        : await getFollowingState(db, actor, ctx.state.account.actor);
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
      },
      where: {
        actorId: actor.id,
        visibility: { in: ["public", "unlisted"] }, // FIXME
        sharedPostId: { isNotNull: true },
        published: { lte: until },
      },
      orderBy: { published: "desc" },
      limit: window + 1,
    });
    const next = posts.length > window ? posts[window].published : undefined;
    ctx.state.title = actor.name ?? actor.username;
    return page<ProfileShareListProps>({
      profileHref: account == null
        ? `/${actor.handle}`
        : `/@${account.username}`,
      actor,
      actorMentions: await extractMentionsFromHtml(
        db,
        ctx.state.fedCtx,
        actor.bioHtml ?? "",
        actor.accountId == null ? { kv } : {
          documentLoader: await ctx.state.fedCtx.getDocumentLoader({
            identifier: actor.accountId,
          }),
          kv,
        },
      ),
      links,
      followingState,
      followedState,
      stats,
      posts: posts.slice(0, window),
      nextHref: next == null
        ? undefined
        : window === DEFAULT_WINDOW
        ? `?until=${+next}`
        : `?until=${+next}&window=${window}`,
    });
  },
});

interface ProfileShareListProps {
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
  })[];
  nextHref?: string;
}

export default define.page<typeof handler, ProfileShareListProps>(
  function ProfileShareList({ data, state }) {
    return (
      <div>
        <Profile
          actor={data.actor}
          actorMentions={data.actorMentions}
          profileHref={data.profileHref}
          followingState={data.followingState}
          followedState={data.followedState}
          links={data.links}
        />
        <ProfileNav
          active="shares"
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
