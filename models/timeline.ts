import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import { getPostVisibilityFilter } from "./post.ts";
import {
  type Account,
  type Actor,
  actorTable,
  type Blocking,
  type Following,
  followingTable,
  type Instance,
  type Mention,
  type NewTimelineItem,
  type Post,
  type PostLink,
  type PostMedium,
  postTable,
  type PostType,
  type Reaction,
  timelineItemTable,
} from "./schema.ts";

export async function addPostToTimeline(
  db: Database,
  post: Post,
): Promise<void> {
  const recipients = await db.query.actorTable.findMany({
    columns: {
      accountId: true,
    },
    where: {
      AND: [
        {
          accountId: { isNotNull: true },
          OR: [
            { id: post.actorId },
            {
              AND: [
                {
                  followees: {
                    followeeId: post.actorId,
                    accepted: { isNotNull: true },
                  },
                },
                post.replyTargetId
                  ? {
                    OR: [
                      { posts: { id: post.replyTargetId } },
                      {
                        followees: {
                          followee: {
                            posts: { id: post.replyTargetId },
                          },
                          accepted: { isNotNull: true },
                        },
                      },
                    ],
                  }
                  : {},
              ],
            },
            { mentions: { postId: post.id } },
            { posts: { quotes: { id: post.id } } },
          ],
        },
        getPostVisibilityFilter(post),
      ],
    },
  });
  if (recipients.length < 1) return;
  const records: NewTimelineItem[] = recipients.map(({ accountId }) => ({
    accountId: accountId!,
    postId: post.sharedPostId ?? post.id,
    originalAuthorId: post.sharedPostId == null ? post.actorId : null,
    lastSharerId: post.sharedPostId == null ? null : post.actorId,
    sharersCount: post.sharedPostId == null ? 0 : 1,
    added: post.published,
    appended: post.published,
  } satisfies NewTimelineItem));
  await db.insert(timelineItemTable)
    .values(records)
    .onConflictDoUpdate({
      target: [timelineItemTable.accountId, timelineItemTable.postId],
      set: {
        lastSharerId: post.sharedPostId == null ? null : post.actorId,
        sharersCount: post.sharedPostId == null
          ? timelineItemTable.sharersCount
          : sql`${timelineItemTable.sharersCount} + 1`,
        appended: post.published,
      },
    });
}

export async function removeFromTimeline(
  db: Database,
  post: Post,
): Promise<void> {
  if (post.sharedPostId == null) return;
  await db.update(timelineItemTable)
    .set({
      lastSharerId: sql`
        CASE ${timelineItemTable.sharersCount}
          WHEN 1 THEN NULL
          ELSE (
            SELECT ${postTable.actorId}
            FROM ${postTable}
            JOIN ${actorTable}
              ON ${actorTable.accountId} = ${timelineItemTable.accountId}
            JOIN ${followingTable}
              ON ${followingTable.followerId} = ${actorTable.id}
            WHERE ${postTable.sharedPostId} = ${post.sharedPostId}
              AND ${postTable.actorId} = ${followingTable.followeeId}
            ORDER BY ${postTable.published} DESC
            LIMIT 1
          )
        END
      `,
      sharersCount: sql`${timelineItemTable.sharersCount} - 1`,
      appended: sql`
        CASE ${timelineItemTable.sharersCount}
          WHEN 1 THEN ${timelineItemTable.added}
          ELSE (
            SELECT coalesce(
              max(${postTable.published}),
              ${timelineItemTable.added}
            )
            FROM ${postTable}
            JOIN ${actorTable}
              ON ${actorTable.accountId} = ${timelineItemTable.accountId}
            JOIN ${followingTable}
              ON ${followingTable.followerId} = ${actorTable.id}
            WHERE ${postTable.sharedPostId} = ${post.sharedPostId}
              AND ${postTable.actorId} = ${followingTable.followeeId}
          )
        END
      `,
    })
    .where(
      and(
        eq(timelineItemTable.postId, post.sharedPostId),
        eq(timelineItemTable.lastSharerId, post.actorId),
      ),
    );
  await db.delete(timelineItemTable)
    .where(
      and(
        isNull(timelineItemTable.originalAuthorId),
        isNull(timelineItemTable.lastSharerId),
      ),
    );
}

export interface TimelineEntry {
  post: Post & {
    actor: Actor & {
      instance: Instance;
      followers: Following[];
      blockees: Blocking[];
      blockers: Blocking[];
    };
    link: PostLink & { creator?: Actor | null } | null;
    sharedPost:
      | Post & {
        actor: Actor & {
          instance: Instance;
          followers: Following[];
          blockees: Blocking[];
          blockers: Blocking[];
        };
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
  lastSharer: Actor | null;
  sharersCount: number;
  added: Date;
}

export interface TimelineOptions {
  readonly local?: boolean;
  readonly withoutShares?: boolean;
  readonly postType?: PostType;
  readonly until?: Date;
  readonly window?: number;
}

export interface PublicTimelineOptions extends TimelineOptions {
  readonly currentAccount?: Account & { actor: Actor } | null;
  readonly languages?: Set<string>;
}

export async function getPublicTimeline(
  db: Database,
  {
    currentAccount,
    languages = new Set(),
    local = false,
    withoutShares = false,
    postType,
    until,
    window,
  }: PublicTimelineOptions,
): Promise<TimelineEntry[]> {
  const posts = await db.query.postTable.findMany({
    with: {
      actor: {
        with: {
          instance: true,
          followers: {
            where: currentAccount
              ? { followerId: currentAccount.actor.id }
              : { RAW: sql`false` },
          },
          blockees: {
            where: currentAccount
              ? { blockeeId: currentAccount.actor.id }
              : { RAW: sql`false` },
          },
          blockers: {
            where: currentAccount
              ? { blockerId: currentAccount.actor.id }
              : { RAW: sql`false` },
          },
        },
      },
      link: { with: { creator: true } },
      sharedPost: {
        with: {
          actor: {
            with: {
              instance: true,
              followers: {
                where: currentAccount
                  ? { followerId: currentAccount.actor.id }
                  : { RAW: sql`false` },
              },
              blockees: {
                where: currentAccount
                  ? { blockeeId: currentAccount.actor.id }
                  : { RAW: sql`false` },
              },
              blockers: {
                where: currentAccount
                  ? { blockerId: currentAccount.actor.id }
                  : { RAW: sql`false` },
              },
            },
          },
          link: { with: { creator: true } },
          replyTarget: {
            with: {
              actor: {
                with: {
                  instance: true,
                  followers: {
                    where: currentAccount
                      ? { followerId: currentAccount.actor.id }
                      : { RAW: sql`false` },
                  },
                  blockees: {
                    where: currentAccount
                      ? { blockeeId: currentAccount.actor.id }
                      : { RAW: sql`false` },
                  },
                  blockers: {
                    where: currentAccount
                      ? { blockerId: currentAccount.actor.id }
                      : { RAW: sql`false` },
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
            where: currentAccount
              ? { actorId: currentAccount.actor.id }
              : { RAW: sql`false` },
          },
          reactions: {
            where: currentAccount
              ? { actorId: currentAccount.actor.id }
              : { RAW: sql`false` },
          },
        },
      },
      replyTarget: {
        with: {
          actor: {
            with: {
              instance: true,
              followers: {
                where: currentAccount
                  ? { followerId: currentAccount.actor.id }
                  : { RAW: sql`false` },
              },
              blockees: {
                where: currentAccount
                  ? { blockeeId: currentAccount.actor.id }
                  : { RAW: sql`false` },
              },
              blockers: {
                where: currentAccount
                  ? { blockerId: currentAccount.actor.id }
                  : { RAW: sql`false` },
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
        where: currentAccount
          ? { actorId: currentAccount.actor.id }
          : { RAW: sql`false` },
      },
      reactions: {
        where: currentAccount
          ? { actorId: currentAccount.actor.id }
          : { RAW: sql`false` },
      },
    },
    where: {
      AND: [
        currentAccount
          ? getPostVisibilityFilter(currentAccount.actor)
          : { visibility: "public" },
        {
          ...(
            languages.size < 1
              ? undefined
              : { language: { in: [...languages] } }
          ),
          replyTargetId: { isNull: true },
          ...(
            local
              ? {
                OR: [
                  { noteSourceId: { isNotNull: true } },
                  { articleSourceId: { isNotNull: true } },
                  {
                    sharedPostId: { isNotNull: true },
                    actor: {
                      accountId: { isNotNull: true },
                    },
                  },
                ],
              }
              : undefined
          ),
          ...(withoutShares ? { sharedPostId: { isNull: true } } : undefined),
          ...(postType == null ? undefined : { type: postType }),
          ...(until == null ? undefined : { published: { lte: until } }),
        },
      ],
    },
    orderBy: { published: "desc" },
    limit: window,
  });
  return posts.map((post) => ({
    post,
    lastSharer: null,
    sharersCount: 0,
    added: post.published,
  }));
}

export interface PersonalTimelineOptions extends TimelineOptions {
  currentAccount: Account & { actor: Actor };
  mentionsAndQuotes?: boolean;
}

export async function getPersonalTimeline(
  db: Database,
  {
    currentAccount,
    local = false,
    withoutShares = false,
    mentionsAndQuotes = false,
    postType,
    until,
    window,
  }: PersonalTimelineOptions,
): Promise<TimelineEntry[]> {
  const timeline = await db.query.timelineItemTable.findMany({
    with: {
      post: {
        with: {
          actor: {
            with: {
              instance: true,
              followers: {
                where: { followerId: currentAccount.actor.id },
              },
              blockees: {
                where: { blockeeId: currentAccount.actor.id },
              },
              blockers: {
                where: { blockerId: currentAccount.actor.id },
              },
            },
          },
          link: { with: { creator: true } },
          sharedPost: {
            with: {
              actor: {
                with: {
                  instance: true,
                  followers: {
                    where: {
                      followerId: currentAccount.actor.id,
                    },
                  },
                  blockees: {
                    where: { blockeeId: currentAccount.actor.id },
                  },
                  blockers: {
                    where: { blockerId: currentAccount.actor.id },
                  },
                },
              },
              link: { with: { creator: true } },
              replyTarget: {
                with: {
                  actor: {
                    with: {
                      instance: true,
                      followers: {
                        where: {
                          followerId: currentAccount.actor.id,
                        },
                      },
                      blockees: {
                        where: { blockeeId: currentAccount.actor.id },
                      },
                      blockers: {
                        where: { blockerId: currentAccount.actor.id },
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
                where: { actorId: currentAccount.actor.id },
              },
              reactions: {
                where: { actorId: currentAccount.actor.id },
              },
            },
          },
          replyTarget: {
            with: {
              actor: {
                with: {
                  instance: true,
                  followers: {
                    where: { followerId: currentAccount.actor.id },
                  },
                  blockees: {
                    where: { blockeeId: currentAccount.actor.id },
                  },
                  blockers: {
                    where: { blockerId: currentAccount.actor.id },
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
            where: { actorId: currentAccount.actor.id },
          },
          reactions: {
            where: { actorId: currentAccount.actor.id },
          },
        },
      },
      lastSharer: true,
    },
    where: {
      accountId: currentAccount.id,
      post: {
        AND: [
          getPostVisibilityFilter(currentAccount.actor),
          local
            ? {
              OR: [
                { noteSourceId: { isNotNull: true } },
                { articleSourceId: { isNotNull: true } },
              ],
            }
            : {},
          mentionsAndQuotes
            ? {
              OR: [
                { mentions: { actorId: currentAccount.actor.id } },
                { quotedPost: { actorId: currentAccount.actor.id } },
              ],
            }
            : {},
          postType == null ? {} : { type: postType },
          currentAccount.hideForeignLanguages && currentAccount.locales != null
            ? { language: { in: currentAccount.locales } }
            : {},
        ],
      },
      ...(withoutShares ? { originalAuthorId: { isNotNull: true } } : {}),
      ...(until == null ? undefined : { added: { lte: until } }),
    },
    orderBy: withoutShares ? { added: "desc" } : { appended: "desc" },
    limit: window,
  });
  if (!withoutShares) return timeline;
  return timeline.map((item) => ({
    ...item,
    lastSharer: null,
    lastSharerId: null,
  }));
}
