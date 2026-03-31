import {
  and,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "./db.ts";
import { getPostVisibilityFilter } from "./post.ts";
import {
  type Account,
  type Actor,
  actorTable,
  type Blocking,
  blockingTable,
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

export const FUTURE_TIMESTAMP_TOLERANCE = (() => {
  const envValue = Deno.env.get("FUTURE_TIMESTAMP_TOLERANCE");
  if (!envValue) return 300000;

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed) || parsed < 0) {
    console.warn(
      `Invalid FUTURE_TIMESTAMP_TOLERANCE: "${envValue}", using default 300000`,
    );
    return 300000;
  }

  return parsed;
})();

function getFutureTimestampLimit(): Date {
  return new Date(Date.now() + FUTURE_TIMESTAMP_TOLERANCE);
}

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
  const futureTimestampLimit = getFutureTimestampLimit();

  // Step 1: Lightweight ID fetch with filters
  // This query uses idx_post_visibility_published index for fast filtering
  const filterConditions = [
    currentAccount
      ? or(
        eq(postTable.actorId, currentAccount.actor.id),
        inArray(postTable.visibility, ["public", "unlisted"]),
      )
      : eq(postTable.visibility, "public"),
    ...(currentAccount
      ? [
        // シェアした人がブロック対象でないか
        sql`NOT EXISTS (
            SELECT 1 FROM ${blockingTable}
            WHERE (blocker_id = ${currentAccount.actor.id} AND blockee_id = ${postTable.actorId})
              OR (blockee_id = ${currentAccount.actor.id} AND blocker_id = ${postTable.actorId})
          )`,
        // シェア元の投稿者もブロック対象でないか
        sql`NOT EXISTS (
            SELECT 1 FROM ${postTable} sp
            JOIN ${blockingTable} ON (
              (blocker_id = ${currentAccount.actor.id} AND blockee_id = sp.actor_id)
              OR (blockee_id = ${currentAccount.actor.id} AND blocker_id = sp.actor_id)
            )
            WHERE sp.id = ${postTable.sharedPostId}
          )`,
      ]
      : []),
    isNull(postTable.replyTargetId),
    ...(languages.size > 0
      ? [inArray(postTable.language, [...languages])]
      : currentAccount?.hideForeignLanguages && currentAccount.locales != null
      ? [inArray(postTable.language, currentAccount.locales)]
      : []),
    ...(local
      ? [
        or(
          isNotNull(postTable.noteSourceId),
          isNotNull(postTable.articleSourceId),
          and(
            isNotNull(postTable.sharedPostId),
            exists(
              db.select({ one: sql`1` })
                .from(actorTable)
                .where(
                  and(
                    eq(actorTable.id, postTable.actorId),
                    isNotNull(actorTable.accountId),
                  ),
                ),
            ),
          ),
        ),
      ]
      : []),
    ...(withoutShares ? [isNull(postTable.sharedPostId)] : []),
    ...(postType != null ? [eq(postTable.type, postType)] : []),
    sql`${postTable.published} <= ${until ?? futureTimestampLimit}`,
  ];

  const idResults = await db
    .select({
      id: postTable.id,
      published: postTable.published,
    })
    .from(postTable)
    .where(and(...filterConditions))
    .orderBy(desc(postTable.published))
    .limit(window ?? 25);

  // If no posts found, return early
  if (idResults.length === 0) {
    return [];
  }

  const postIds = idResults.map((r) => r.id);

  // Step 2: Hydrate posts with all relationships
  // Only fetch the exact posts we need with all their relationships
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
      id: { in: postIds },
      AND: [
        currentAccount
          ? {
            OR: [
              { actorId: currentAccount.actor.id },
              { visibility: { in: ["public", "unlisted"] } },
            ],
          }
          : { visibility: "public" },
      ],
    },
  });

  // Step 3: Sort posts back to original order from Step 1
  const postMap = new Map(posts.map((p) => [p.id, p]));
  const orderedPosts = idResults
    .map((idResult) => postMap.get(idResult.id))
    .filter((p): p is NonNullable<typeof p> => p != null);

  return orderedPosts.map((post) => ({
    post,
    lastSharer: null,
    sharersCount: 0,
    added: post.published,
  }));
}

export interface PersonalTimelineOptions extends TimelineOptions {
  currentAccount: Account & { actor: Actor };
}

export async function getPersonalTimeline(
  db: Database,
  {
    currentAccount,
    local = false,
    withoutShares = false,
    postType,
    until,
    window,
  }: PersonalTimelineOptions,
): Promise<TimelineEntry[]> {
  const futureTimestampLimit = getFutureTimestampLimit();
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
          postType == null ? {} : { type: postType },
          currentAccount.hideForeignLanguages && currentAccount.locales != null
            ? { language: { in: currentAccount.locales } }
            : {},
          {
            published: {
              lte: futureTimestampLimit,
            },
          },
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
