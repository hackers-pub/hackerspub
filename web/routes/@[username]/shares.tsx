import { page } from "@fresh/core";
import { getRelationship, type Relationship } from "@hackerspub/models/account";
import { type ActorStats, getActorStats } from "@hackerspub/models/actor";
import { extractMentionsFromHtml } from "@hackerspub/models/markup";
import { getPostVisibilityFilter } from "@hackerspub/models/post";
import type {
  Account,
  AccountLink,
  Actor,
  Blocking,
  Following,
  Instance,
  Mention,
  Post,
  PostLink,
  PostMedium,
  Reaction,
} from "@hackerspub/models/schema";
import { sql } from "drizzle-orm";
import { PostExcerpt } from "../../components/PostExcerpt.tsx";
import { PostPagination } from "../../components/PostPagination.tsx";
import { Profile } from "../../components/Profile.tsx";
import { ProfileNav } from "../../components/ProfileNav.tsx";
import { db } from "../../db.ts";
import { kv } from "../../kv.ts";
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
          {
            actorId: actor.id,
            sharedPostId: { isNotNull: true },
            published: { lte: until },
          },
          getPostVisibilityFilter(ctx.state.account?.actor ?? null),
        ],
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
      relationship: await getRelationship(db, ctx.state.account, actor),
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
  relationship: Relationship | null;
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
          relationship={data.relationship}
          links={data.links}
        />
        <ProfileNav
          active="shares"
          stats={data.stats}
          profileHref={data.profileHref}
        />
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
