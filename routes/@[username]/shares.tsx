import { and, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { page } from "fresh";
import { PostExcerpt } from "../../components/PostExcerpt.tsx";
import { PostPagination } from "../../components/PostPagination.tsx";
import { Profile } from "../../components/Profile.tsx";
import { ProfileNav } from "../../components/ProfileNav.tsx";
import { db } from "../../db.ts";
import { type ActorStats, getActorStats } from "../../models/actor.ts";
import {
  type FollowingState,
  getFollowingState,
} from "../../models/following.ts";
import {
  type Account,
  type AccountLink,
  type Actor,
  actorTable,
  type Post,
  type PostMedium,
  postTable,
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
    let actor: Actor | undefined;
    let links: AccountLink[] | undefined;
    if (ctx.params.username.includes("@")) {
      const username = ctx.params.username.replace(/@.*$/, "");
      const host = ctx.params.username.substring(
        ctx.params.username.indexOf("@") + 1,
      );
      actor = await db.query.actorTable.findFirst({
        where: and(
          eq(actorTable.username, username),
          eq(actorTable.instanceHost, host),
        ),
      });
      if (actor == null) return ctx.next();
    } else {
      const acct = await db.query.accountTable.findFirst({
        with: { actor: true, links: true },
        where: eq(actorTable.username, ctx.params.username),
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
        isNotNull(postTable.sharedPostId),
        until == null ? undefined : lte(postTable.published, until),
      ),
      orderBy: desc(postTable.published),
      limit: window + 1,
    });
    const next = posts.length > window ? posts[window].published : undefined;
    return page<ProfileShareListProps>({
      profileHref: account == null
        ? `/@${actor.username}@${actor.instanceHost}`
        : `/@${account.username}`,
      actor,
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

export default define.page<typeof handler, ProfileShareListProps>(
  function ProfileShareList({ data, state }) {
    return (
      <div>
        <Profile
          actor={data.actor}
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
