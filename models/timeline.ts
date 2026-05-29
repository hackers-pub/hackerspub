import process from "node:process";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database, RelationsFilter } from "./db.ts";
import {
  getMutedActorExclusionFilter,
  getPostVisibilityFilter,
  getPublicTimelineVisibilityFilter,
} from "./post.ts";
import {
  type Account,
  type Actor,
  actorTable,
  type Blocking,
  type Following,
  followingTable,
  hashtagFollowingTable,
  type Instance,
  type Mention,
  mutingTable,
  type NewTimelineItem,
  type Post,
  type PostLink,
  type PostMedium,
  postTable,
  type PostType,
  type Reaction,
  timelineItemTable,
} from "./schema.ts";
import { type Uuid, validateUuid } from "./uuid.ts";

// Extra rows fetched beyond the caller's window so that after filtering out
// actor-deleted rows the caller still receives the full window plus the
// hasNextPage probe row.
const ACTOR_RACE_BUFFER = 5;
const PUBLIC_TIMELINE_HYDRATION_BATCH_SIZE = 250;

export const FUTURE_TIMESTAMP_TOLERANCE = (() => {
  const envValue = process.env.FUTURE_TIMESTAMP_TOLERANCE;
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

export function expandLocales(locales: string[]): string[] {
  return [
    ...new Set(
      locales.flatMap((l) => {
        const dashIdx = l.indexOf("-");
        return dashIdx > 0 ? [l, l.slice(0, dashIdx)] : [l];
      }),
    ),
  ];
}

// Extracts unique base language codes from a set of BCP 47 tags.
// "en-US" → "en"; "en" → "en"; duplicates are removed.
// This ensures that region-specific locales (e.g. from user preferences)
// are treated the same as base language codes for prefix-match filtering.
function toBaseLangs(languages: Set<string>): string[] {
  const seen = new Set<string>();
  for (const lang of languages) {
    try {
      seen.add(new Intl.Locale(lang).language);
    } catch {
      const dash = lang.indexOf("-");
      seen.add(dash > 0 ? lang.slice(0, dash) : lang);
    }
  }
  return [...seen];
}

// Builds a Drizzle-compatible RAW SQL filter where each base language code is
// matched as a prefix: "en" (and "en-US") both match "en" and "en-*". Used
// for direct postTable queries (public timeline). The personal timeline uses a
// correlated EXISTS predicate at the timelineItemTable level instead, because
// Drizzle's RAW callback in nested relation filters receives the outer table
// reference rather than the relation table's columns.
function buildLanguagePrefixFilter(
  languages: Set<string>,
): RelationsFilter<"postTable"> {
  const baseLangs = toBaseLangs(languages);
  if (baseLangs.length === 0) return {};
  return {
    RAW: (post: typeof postTable) => {
      const conditions = baseLangs.map((base) =>
        sql`(${post.language} = ${base} OR ${post.language} LIKE ${
          base + "-%"
        })`
      );
      if (conditions.length === 1) return conditions[0];
      return sql`(${sql.join(conditions, sql` OR `)})`;
    },
  };
}

type SocialGraphMaps = {
  followingMap: Map<Uuid, Following>;
  blockeeMap: Map<Uuid, Blocking>;
  blockerMap: Map<Uuid, Blocking>;
};

const EMPTY_SOCIAL_GRAPH: SocialGraphMaps = {
  followingMap: new Map(),
  blockeeMap: new Map(),
  blockerMap: new Map(),
};

async function fetchSocialGraph(
  db: Database,
  currentActorId: Uuid,
  actorIds: Uuid[],
): Promise<SocialGraphMaps> {
  if (actorIds.length === 0) return EMPTY_SOCIAL_GRAPH;
  const [followings, blockees, blockers] = await Promise.all([
    db.query.followingTable.findMany({
      where: { followerId: currentActorId, followeeId: { in: actorIds } },
    }),
    db.query.blockingTable.findMany({
      where: { blockeeId: currentActorId, blockerId: { in: actorIds } },
    }),
    db.query.blockingTable.findMany({
      where: { blockerId: currentActorId, blockeeId: { in: actorIds } },
    }),
  ]);
  return {
    followingMap: new Map(followings.map((f) => [f.followeeId as Uuid, f])),
    blockeeMap: new Map(blockees.map((b) => [b.blockerId as Uuid, b])),
    blockerMap: new Map(blockers.map((b) => [b.blockeeId as Uuid, b])),
  };
}

function enrichActor<T extends { id: unknown }>(
  actor: T,
  { followingMap, blockeeMap, blockerMap }: SocialGraphMaps,
): T & { followers: Following[]; blockees: Blocking[]; blockers: Blocking[] } {
  const id = actor.id as Uuid;
  return {
    ...actor,
    followers: followingMap.has(id) ? [followingMap.get(id)!] : [],
    blockees: blockeeMap.has(id) ? [blockeeMap.get(id)!] : [],
    blockers: blockerMap.has(id) ? [blockerMap.get(id)!] : [],
  };
}

function collectPostActorIds(
  post: {
    actor?: { id: unknown } | null;
    sharedPost?: {
      actor?: { id: unknown } | null;
      replyTarget?: { actor?: { id: unknown } | null } | null;
      quotedPost?: { actor?: { id: unknown } | null } | null;
    } | null;
    replyTarget?: { actor?: { id: unknown } | null } | null;
    quotedPost?: { actor?: { id: unknown } | null } | null;
  },
  ids: Set<Uuid>,
): void {
  if (post.actor?.id != null) ids.add(post.actor.id as Uuid);
  if (post.sharedPost?.actor?.id != null) {
    ids.add(post.sharedPost.actor.id as Uuid);
  }
  if (post.sharedPost?.replyTarget?.actor?.id != null) {
    ids.add(post.sharedPost.replyTarget.actor.id as Uuid);
  }
  if (post.sharedPost?.quotedPost?.actor?.id != null) {
    ids.add(post.sharedPost.quotedPost.actor.id as Uuid);
  }
  if (post.replyTarget?.actor?.id != null) {
    ids.add(post.replyTarget.actor.id as Uuid);
  }
  if (post.quotedPost?.actor?.id != null) {
    ids.add(post.quotedPost.actor.id as Uuid);
  }
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
        // For a share (boost), skip recipients who mute the sharer so the
        // muted actor's boosts never enter (or bump) their feed. Originals
        // (sharedPostId == null) still fan out and are hidden at read time by
        // getMutedActorExclusionFilter, so unmuting restores them.
        ...(post.sharedPostId == null
          ? []
          : [{ NOT: { mutees: { muteeId: post.actorId } } }]),
      ],
    },
  });
  if (recipients.length < 1) return;
  // `timeline_item.post_type` is set by the BEFORE INSERT/UPDATE trigger
  // installed in the migration — it always derives the value from the
  // `post` row that `post_id` points to (with a SHARE row lock to block
  // concurrent type changes), so the type is correct for both originals and
  // shares without us having to resolve it here. We still have to pass
  // *something* because the column is NOT NULL and Drizzle's typed insert
  // requires it; `post.type` is fine as a placeholder, the trigger will
  // overwrite it before the row hits the heap.
  const records: NewTimelineItem[] = recipients.map(({ accountId }) => ({
    accountId: accountId!,
    postId: post.sharedPostId ?? post.id,
    postType: post.type,
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
        // Don't touch post_type on the conflict path. The existing row was
        // inserted with a trigger-derived value, and the AFTER UPDATE OF
        // type trigger on `post` keeps it synced with any later type
        // changes — re-writing it here would just re-fire the fill trigger
        // and re-take the SHARE lock for no reason.
      },
    });

  // Fan out to accounts that follow any of the post's hashtags. Only
  // public posts are included — hashtag followers have no follower
  // relationship with the author, so follower-only/DM posts must stay
  // out of their feeds.
  if (post.visibility === "public" && post.sharedPostId == null) {
    const tagNames = Object.keys(post.tags ?? {});
    if (tagNames.length > 0) {
      const tagFollowers = await db
        .selectDistinct({ accountId: hashtagFollowingTable.accountId })
        .from(hashtagFollowingTable)
        .where(inArray(hashtagFollowingTable.tag, tagNames));
      if (tagFollowers.length > 0) {
        const tagRecords: NewTimelineItem[] = tagFollowers.map(
          ({ accountId }) => ({
            accountId,
            postId: post.id,
            postType: post.type,
            originalAuthorId: post.actorId,
            lastSharerId: null,
            sharersCount: 0,
            added: post.published,
            appended: post.published,
          } satisfies NewTimelineItem),
        );
        await db.insert(timelineItemTable)
          .values(tagRecords)
          .onConflictDoNothing();
      }
    }
  }
}

export async function addTagsPubPostToTimeline(
  db: Database,
  post: Post,
): Promise<void> {
  if (post.visibility !== "public") return;
  const tagNames = Object.keys(post.tags ?? {});
  if (tagNames.length === 0) return;
  const tagFollowers = await db
    .selectDistinct({ accountId: hashtagFollowingTable.accountId })
    .from(hashtagFollowingTable)
    .where(inArray(hashtagFollowingTable.tag, tagNames));
  if (tagFollowers.length === 0) return;
  await db.insert(timelineItemTable)
    .values(
      tagFollowers.map(({ accountId }) => ({
        accountId,
        postId: post.id,
        postType: post.type,
        originalAuthorId: post.actorId,
        lastSharerId: null,
        sharersCount: 0,
        added: post.published,
        appended: post.published,
      } satisfies NewTimelineItem)),
    )
    .onConflictDoNothing();
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
              AND ${followingTable.accepted} IS NOT NULL
            WHERE ${postTable.sharedPostId} = ${post.sharedPostId}
              AND ${postTable.actorId} = ${followingTable.followeeId}
              AND ${postTable.visibility} IN ('public', 'unlisted', 'followers')
              AND NOT EXISTS (
                SELECT 1 FROM ${mutingTable}
                WHERE ${mutingTable.muterId} = ${actorTable.id}
                  AND ${mutingTable.muteeId} = ${postTable.actorId}
              )
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
              AND ${followingTable.accepted} IS NOT NULL
            WHERE ${postTable.sharedPostId} = ${post.sharedPostId}
              AND ${postTable.actorId} = ${followingTable.followeeId}
              AND ${postTable.visibility} IN ('public', 'unlisted', 'followers')
              AND NOT EXISTS (
                SELECT 1 FROM ${mutingTable}
                WHERE ${mutingTable.muterId} = ${actorTable.id}
                  AND ${mutingTable.muteeId} = ${postTable.actorId}
              )
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

/**
 * Removes a newly muted actor's boosts from the muter's personal timeline.
 *
 * Call right after the mute row is inserted. For each of the muter's timeline
 * rows whose most recent sharer is the muted actor, the last sharer is
 * recomputed to the latest still-followed, non-muted sharer of the same post
 * (mirroring {@link removeFromTimeline}); `sharersCount` and `appended` follow.
 * Rows left with neither a followed original author nor any such sharer are
 * deleted. Future boosts by the muted actor are kept out separately by
 * {@link addPostToTimeline}. The muted actor's own authored posts are left in
 * place (followers keep the row) and hidden at read time, so unmuting restores
 * them.
 */
export async function pruneMutedActorFromTimeline(
  db: Database,
  muterAccountId: Uuid,
  muterActorId: Uuid,
  muteeActorId: Uuid,
): Promise<void> {
  await db.update(timelineItemTable)
    .set({
      lastSharerId: sql`(
        SELECT ${postTable.actorId}
        FROM ${postTable}
        JOIN ${followingTable}
          ON ${followingTable.followerId} = ${muterActorId}
          AND ${followingTable.followeeId} = ${postTable.actorId}
          AND ${followingTable.accepted} IS NOT NULL
        WHERE ${postTable.sharedPostId} = ${timelineItemTable.postId}
          AND ${postTable.visibility} IN ('public', 'unlisted', 'followers')
          AND NOT EXISTS (
            SELECT 1
            FROM ${mutingTable}
            WHERE ${mutingTable.muterId} = ${muterActorId}
              AND ${mutingTable.muteeId} = ${postTable.actorId}
          )
        ORDER BY ${postTable.published} DESC
        LIMIT 1
      )`,
      appended: sql`(
        SELECT coalesce(max(${postTable.published}), ${timelineItemTable.added})
        FROM ${postTable}
        JOIN ${followingTable}
          ON ${followingTable.followerId} = ${muterActorId}
          AND ${followingTable.followeeId} = ${postTable.actorId}
          AND ${followingTable.accepted} IS NOT NULL
        WHERE ${postTable.sharedPostId} = ${timelineItemTable.postId}
          AND ${postTable.visibility} IN ('public', 'unlisted', 'followers')
          AND NOT EXISTS (
            SELECT 1
            FROM ${mutingTable}
            WHERE ${mutingTable.muterId} = ${muterActorId}
              AND ${mutingTable.muteeId} = ${postTable.actorId}
          )
      )`,
      sharersCount: sql`(
        SELECT count(DISTINCT ${postTable.actorId})
        FROM ${postTable}
        JOIN ${followingTable}
          ON ${followingTable.followerId} = ${muterActorId}
          AND ${followingTable.followeeId} = ${postTable.actorId}
          AND ${followingTable.accepted} IS NOT NULL
        WHERE ${postTable.sharedPostId} = ${timelineItemTable.postId}
          AND ${postTable.visibility} IN ('public', 'unlisted', 'followers')
          AND NOT EXISTS (
            SELECT 1
            FROM ${mutingTable}
            WHERE ${mutingTable.muterId} = ${muterActorId}
              AND ${mutingTable.muteeId} = ${postTable.actorId}
          )
      )`,
    })
    .where(
      and(
        eq(timelineItemTable.accountId, muterAccountId),
        eq(timelineItemTable.lastSharerId, muteeActorId),
      ),
    );
  await db.delete(timelineItemTable)
    .where(
      and(
        eq(timelineItemTable.accountId, muterAccountId),
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
        quotedPost:
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
    quotedPost:
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
  cursor: Date;
}

export interface TimelineCursor {
  readonly timestamp: Date;
  readonly postId?: Uuid;
}

export function parseTimelineCursor(raw: string): TimelineCursor | undefined {
  const separatorIndex = raw.indexOf("|");
  if (separatorIndex < 0) {
    const timestamp = raw.match(/^\d+(\.\d+)?$/)
      ? new Date(parseInt(raw, 10))
      : new Date(raw);
    return isNaN(timestamp.getTime()) ? undefined : { timestamp };
  }

  const timestamp = new Date(raw.slice(0, separatorIndex));
  const postId = raw.slice(separatorIndex + 1);
  if (isNaN(timestamp.getTime())) return undefined;
  if (!validateUuid(postId)) return undefined;
  return { timestamp, postId };
}

export function formatTimelineCursor(
  entry: Pick<TimelineEntry, "cursor" | "post">,
): string {
  return `${entry.cursor.toISOString()}|${entry.post.id}`;
}

export interface TimelineOptions {
  readonly direction?: "backward" | "forward";
  readonly local?: boolean;
  readonly withoutShares?: boolean;
  readonly postType?: PostType;
  readonly since?: TimelineCursor;
  readonly until?: TimelineCursor;
  readonly window?: number;
}

export interface PublicTimelineOptions extends TimelineOptions {
  readonly currentAccount?: Account & { actor: Actor } | null;
  readonly languages?: Set<string>;
}

// Sanitizes the eagerly-loaded sub-relations of a timeline post by nulling
// out any nested Post (sharedPost, replyTarget, quotedPost) whose actor
// was dropped by the same race condition, and by stripping Mention rows
// whose actor was similarly dropped.  Using `unknown` for the actor type
// allows the null check to compile even though Drizzle's return types mark
// the actor as non-nullable.
function sanitizePostActors<
  T extends {
    sharedPost?: {
      actor: unknown;
      replyTarget?:
        | { actor: unknown; mentions: { actor: unknown }[] }
        | null;
      quotedPost?:
        | { actor: unknown; mentions: { actor: unknown }[] }
        | null;
      mentions: { actor: unknown }[];
    } | null;
    replyTarget?:
      | { actor: unknown; mentions: { actor: unknown }[] }
      | null;
    quotedPost?:
      | { actor: unknown; mentions: { actor: unknown }[] }
      | null;
    mentions: { actor: unknown }[];
  },
>(post: T): T {
  const sanitizeLeaf = <
    L extends { actor: unknown; mentions: { actor: unknown }[] },
  >(
    leaf: L | null | undefined,
  ): L | null => {
    if (leaf == null || leaf.actor == null) return null;
    return { ...leaf, mentions: leaf.mentions.filter((m) => m.actor != null) };
  };
  const sp = post.sharedPost;
  return {
    ...post,
    sharedPost: sp == null || sp.actor == null ? null : {
      ...sp,
      replyTarget: sanitizeLeaf(sp.replyTarget),
      quotedPost: sanitizeLeaf(sp.quotedPost),
      mentions: sp.mentions.filter((m) => m.actor != null),
    },
    replyTarget: sanitizeLeaf(post.replyTarget),
    quotedPost: sanitizeLeaf(post.quotedPost),
    mentions: post.mentions.filter((m) => m.actor != null),
  } as T;
}

function getPostCursorFilter(
  cursor: TimelineCursor,
  boundary: "newer" | "older",
) {
  const timestamp = cursor.timestamp.toISOString();
  if (cursor.postId == null) {
    return {
      RAW: (post: typeof postTable) =>
        boundary === "newer"
          ? sql`${post.published}::timestamptz(3) > ${timestamp}::timestamptz(3)`
          : sql`${post.published}::timestamptz(3) < ${timestamp}::timestamptz(3)`,
    };
  }

  const postId = cursor.postId;
  return {
    RAW: (post: typeof postTable) =>
      boundary === "newer"
        ? sql`(${post.published}::timestamptz(3) > ${timestamp}::timestamptz(3) OR (${post.published}::timestamptz(3) = ${timestamp}::timestamptz(3) AND ${post.id} > ${postId}::uuid))`
        : sql`(${post.published}::timestamptz(3) < ${timestamp}::timestamptz(3) OR (${post.published}::timestamptz(3) = ${timestamp}::timestamptz(3) AND ${post.id} < ${postId}::uuid))`,
  };
}

function getTimelineItemCursorFilter(
  cursor: TimelineCursor,
  useAddedColumn: boolean,
  boundary: "newer" | "older",
) {
  const timestamp = cursor.timestamp.toISOString();
  if (cursor.postId == null) {
    return {
      RAW: (timelineItem: typeof timelineItemTable) => {
        const cursorColumn = useAddedColumn
          ? timelineItem.added
          : timelineItem.appended;
        return boundary === "newer"
          ? sql`${cursorColumn}::timestamptz(3) > ${timestamp}::timestamptz(3)`
          : sql`${cursorColumn}::timestamptz(3) < ${timestamp}::timestamptz(3)`;
      },
    };
  }

  const postId = cursor.postId;
  return {
    RAW: (timelineItem: typeof timelineItemTable) => {
      const cursorColumn = useAddedColumn
        ? timelineItem.added
        : timelineItem.appended;
      return boundary === "newer"
        ? sql`(${cursorColumn}::timestamptz(3) > ${timestamp}::timestamptz(3) OR (${cursorColumn}::timestamptz(3) = ${timestamp}::timestamptz(3) AND ${timelineItem.postId} > ${postId}::uuid))`
        : sql`(${cursorColumn}::timestamptz(3) < ${timestamp}::timestamptz(3) OR (${cursorColumn}::timestamptz(3) = ${timestamp}::timestamptz(3) AND ${timelineItem.postId} < ${postId}::uuid))`;
    },
  };
}

export async function getPublicTimeline(
  db: Database,
  {
    currentAccount,
    direction = "forward",
    languages = new Set(),
    local = false,
    withoutShares = false,
    postType,
    since,
    until,
    window,
  }: PublicTimelineOptions,
): Promise<TimelineEntry[]> {
  const futureTimestampLimit = getFutureTimestampLimit();
  // Refill loop: keep fetching additional batches until `window` sanitized
  // entries are collected or the DB has no more rows.  Each iteration replaces
  // the tail-side cursor (older for forward, newer for backward) with the
  // composite (timestamp, postId) of the last row seen so far.
  const result: TimelineEntry[] = [];
  let refillNewerCursor = since;
  let refillOlderCursor = until;

  while (window == null || result.length < window) {
    const batchCursorFilters = [
      refillNewerCursor == null
        ? undefined
        : getPostCursorFilter(refillNewerCursor, "newer"),
      refillOlderCursor == null
        ? undefined
        : getPostCursorFilter(refillOlderCursor, "older"),
    ].filter((f) => f != null);
    const needed = window == null ? undefined : window - result.length;
    const batchNeeded = needed == null
      ? PUBLIC_TIMELINE_HYDRATION_BATCH_SIZE
      : Math.min(needed, PUBLIC_TIMELINE_HYDRATION_BATCH_SIZE);
    const batchLimit = batchNeeded + ACTOR_RACE_BUFFER;
    const batchFilter: RelationsFilter<"postTable"> = {
      AND: [
        getPublicTimelineVisibilityFilter(currentAccount?.actor ?? null),
        ...(currentAccount == null
          ? []
          : [getMutedActorExclusionFilter(currentAccount.actor.id)]),
        ...batchCursorFilters,
        languages.size < 1
          ? (currentAccount?.hideForeignLanguages &&
              currentAccount.locales != null
            ? { language: { in: expandLocales(currentAccount.locales) } }
            : {})
          : buildLanguagePrefixFilter(languages),
        {
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
          published: { lte: futureTimestampLimit },
        },
      ],
    };

    const candidatePosts = await db.query.postTable.findMany({
      columns: {
        id: true,
        published: true,
      },
      where: batchFilter,
      orderBy: (post, { asc, desc }) => {
        const cursorTimestamp = sql<Date>`${post.published}::timestamptz(3)`;
        return [
          direction === "backward"
            ? asc(cursorTimestamp)
            : desc(cursorTimestamp),
          direction === "backward" ? asc(post.id) : desc(post.id),
        ];
      },
      limit: batchLimit,
    });

    if (candidatePosts.length === 0) break;

    // Advance the tail-side cursor using the last candidate's composite key.
    const lastPost = candidatePosts.at(-1)!;
    const lastCursor: TimelineCursor = {
      timestamp: lastPost.published,
      postId: lastPost.id as Uuid,
    };
    if (direction === "forward") refillOlderCursor = lastCursor;
    else refillNewerCursor = lastCursor;

    const candidatePostIds = candidatePosts.map((post) => post.id as Uuid);
    const candidateOrder = new Map(
      candidatePostIds.map((id, index) => [id, index]),
    );

    const posts = await db.query.postTable.findMany({
      with: {
        actor: {
          with: { instance: true },
        },
        link: { with: { creator: true } },
        sharedPost: {
          with: {
            actor: {
              with: { instance: true },
            },
            link: { with: { creator: true } },
            replyTarget: {
              with: {
                actor: {
                  with: { instance: true },
                },
                link: { with: { creator: true } },
                mentions: {
                  with: { actor: true },
                },
                media: true,
              },
            },
            quotedPost: {
              with: {
                actor: {
                  with: { instance: true },
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
              with: { instance: true },
            },
            link: { with: { creator: true } },
            mentions: {
              with: { actor: true },
            },
            media: true,
          },
        },
        quotedPost: {
          with: {
            actor: {
              with: { instance: true },
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
          { id: { in: candidatePostIds } },
          batchFilter,
        ],
      },
    });
    posts.sort((a, b) =>
      (candidateOrder.get(a.id as Uuid) ?? Number.MAX_SAFE_INTEGER) -
      (candidateOrder.get(b.id as Uuid) ?? Number.MAX_SAFE_INTEGER)
    );

    // Bulk-fetch follows/blocks for every actor that appears in this batch.
    const actorIdSet = new Set<Uuid>();
    for (const post of posts) collectPostActorIds(post, actorIdSet);
    const socialGraph = currentAccount
      ? await fetchSocialGraph(
        db,
        currentAccount.actor.id as Uuid,
        [...actorIdSet],
      )
      : EMPTY_SOCIAL_GRAPH;

    for (const post of posts) {
      if (post.actor == null) continue;
      if (window != null && result.length >= window) break;
      const enrichedPost = {
        ...post,
        actor: enrichActor(post.actor, socialGraph),
        sharedPost: post.sharedPost == null || post.sharedPost.actor == null
          ? null
          : {
            ...post.sharedPost,
            actor: enrichActor(post.sharedPost.actor, socialGraph),
            replyTarget: post.sharedPost.replyTarget == null ||
                post.sharedPost.replyTarget.actor == null
              ? null
              : {
                ...post.sharedPost.replyTarget,
                actor: enrichActor(
                  post.sharedPost.replyTarget.actor,
                  socialGraph,
                ),
              },
            quotedPost: post.sharedPost.quotedPost == null ||
                post.sharedPost.quotedPost.actor == null
              ? null
              : {
                ...post.sharedPost.quotedPost,
                actor: enrichActor(
                  post.sharedPost.quotedPost.actor,
                  socialGraph,
                ),
              },
          },
        replyTarget: post.replyTarget == null || post.replyTarget.actor == null
          ? null
          : {
            ...post.replyTarget,
            actor: enrichActor(post.replyTarget.actor, socialGraph),
          },
        quotedPost: post.quotedPost == null || post.quotedPost.actor == null
          ? null
          : {
            ...post.quotedPost,
            actor: enrichActor(post.quotedPost.actor, socialGraph),
          },
      };
      result.push({
        post: sanitizePostActors(
          enrichedPost as unknown as typeof post & {
            actor: NonNullable<typeof post.actor>;
          },
        ) as unknown as TimelineEntry["post"],
        lastSharer: null,
        sharersCount: 0,
        added: post.published,
        cursor: post.published,
      });
    }

    if (candidatePosts.length < batchLimit) break;
  }

  return result;
}

export interface PersonalTimelineOptions extends TimelineOptions {
  currentAccount: Account & { actor: Actor };
  readonly languages?: Set<string>;
}

export async function getPersonalTimeline(
  db: Database,
  {
    currentAccount,
    direction = "forward",
    languages,
    local = false,
    withoutShares = false,
    postType,
    since,
    until,
    window,
  }: PersonalTimelineOptions,
): Promise<TimelineEntry[]> {
  const futureTimestampLimit = getFutureTimestampLimit();
  // Refill loop: same strategy as getPublicTimeline.
  const result: TimelineEntry[] = [];
  let refillNewerCursor = since;
  let refillOlderCursor = until;

  while (window == null || result.length < window) {
    const batchCursorFilters = [
      refillNewerCursor == null ? undefined : getTimelineItemCursorFilter(
        refillNewerCursor,
        withoutShares,
        "newer",
      ),
      refillOlderCursor == null ? undefined : getTimelineItemCursorFilter(
        refillOlderCursor,
        withoutShares,
        "older",
      ),
    ].filter((f) => f != null);
    const needed = window == null ? undefined : window - result.length;

    const items = await db.query.timelineItemTable.findMany({
      with: {
        post: {
          with: {
            actor: {
              with: { instance: true },
            },
            link: { with: { creator: true } },
            sharedPost: {
              with: {
                actor: {
                  with: { instance: true },
                },
                link: { with: { creator: true } },
                replyTarget: {
                  with: {
                    actor: {
                      with: { instance: true },
                    },
                    link: { with: { creator: true } },
                    mentions: {
                      with: { actor: true },
                    },
                    media: true,
                  },
                },
                quotedPost: {
                  with: {
                    actor: {
                      with: { instance: true },
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
                  with: { instance: true },
                },
                link: { with: { creator: true } },
                mentions: {
                  with: { actor: true },
                },
                media: true,
              },
            },
            quotedPost: {
              with: {
                actor: {
                  with: { instance: true },
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
        // Filter on the denormalized `timeline_item.post_type` rather than
        // joining `post` and filtering on `post.type`. With the
        // `(account_id, post_type, …)` composite index this lets the planner
        // satisfy /feed/articles (and any other postType-filtered timeline)
        // directly from the index instead of scanning the unfiltered timeline
        // and rejecting the wrong types after a row-by-row JOIN.
        ...(postType == null ? {} : { postType }),
        ...(batchCursorFilters.length < 1 ? {} : { AND: batchCursorFilters }),
        // Language filter: pushed to SQL via a correlated EXISTS subquery so
        // it is applied before Drizzle hydrates the full post relations.
        // Note: Drizzle's RAW callback in the nested `post: {}` relation filter
        // receives the outer table ref rather than postTable, so we attach this
        // predicate at the timelineItemTable level instead.
        ...(languages != null && languages.size > 0
          ? {
            RAW: (ti: typeof timelineItemTable) => {
              const baseLangs = toBaseLangs(languages);
              const langConds = baseLangs.map((base) =>
                sql`(${postTable.language} = ${base} OR ${postTable.language} LIKE ${
                  base + "-%"
                })`
              );
              const langWhere = langConds.length === 1
                ? langConds[0]
                : sql`(${sql.join(langConds, sql` OR `)})`;
              return sql`EXISTS (SELECT 1 FROM ${postTable} WHERE ${postTable.id} = ${ti.postId} AND ${langWhere})`;
            },
          }
          : {}),
        post: {
          AND: [
            getPostVisibilityFilter(currentAccount.actor),
            getMutedActorExclusionFilter(currentAccount.actor.id),
            local
              ? {
                OR: [
                  { noteSourceId: { isNotNull: true } },
                  { articleSourceId: { isNotNull: true } },
                ],
              }
              : {},
            currentAccount.hideForeignLanguages &&
              currentAccount.locales != null &&
              (languages == null || languages.size === 0)
              ? { language: { in: expandLocales(currentAccount.locales) } }
              : {},
            {
              published: {
                lte: futureTimestampLimit,
              },
            },
          ],
        },
        ...(withoutShares ? { originalAuthorId: { isNotNull: true } } : {}),
      },
      orderBy: (timelineItem, { asc, desc }) => {
        const cursorTimestamp = withoutShares
          ? sql<Date>`${timelineItem.added}::timestamptz(3)`
          : sql<Date>`${timelineItem.appended}::timestamptz(3)`;
        return [
          direction === "backward"
            ? asc(cursorTimestamp)
            : desc(cursorTimestamp),
          direction === "backward"
            ? asc(timelineItem.postId)
            : desc(timelineItem.postId),
        ];
      },
      limit: needed != null ? needed + ACTOR_RACE_BUFFER : undefined,
    });

    if (items.length === 0) break;

    // Advance the tail-side cursor for the next refill batch.
    const lastItem = items.at(-1)!;
    const lastCursor: TimelineCursor = {
      timestamp: withoutShares ? lastItem.added : lastItem.appended,
      postId: lastItem.postId,
    };
    if (direction === "forward") refillOlderCursor = lastCursor;
    else refillNewerCursor = lastCursor;

    // Bulk-fetch follows/blocks for every actor that appears in this batch.
    const actorIdSet = new Set<Uuid>();
    for (const item of items) {
      if (item.post != null) collectPostActorIds(item.post, actorIdSet);
    }
    const socialGraph = await fetchSocialGraph(
      db,
      currentAccount.actor.id as Uuid,
      [...actorIdSet],
    );

    for (const item of items) {
      const post = item.post as { actor: unknown } | null;
      if (post == null || post.actor == null) continue;
      if (window != null && result.length >= window) break;
      const enrichedPost = {
        ...item.post!,
        actor: enrichActor(item.post!.actor!, socialGraph),
        sharedPost: item.post!.sharedPost == null ||
            item.post!.sharedPost.actor == null
          ? null
          : {
            ...item.post!.sharedPost,
            actor: enrichActor(item.post!.sharedPost.actor, socialGraph),
            replyTarget: item.post!.sharedPost.replyTarget == null ||
                item.post!.sharedPost.replyTarget.actor == null
              ? null
              : {
                ...item.post!.sharedPost.replyTarget,
                actor: enrichActor(
                  item.post!.sharedPost.replyTarget.actor,
                  socialGraph,
                ),
              },
            quotedPost: item.post!.sharedPost.quotedPost == null ||
                item.post!.sharedPost.quotedPost.actor == null
              ? null
              : {
                ...item.post!.sharedPost.quotedPost,
                actor: enrichActor(
                  item.post!.sharedPost.quotedPost.actor,
                  socialGraph,
                ),
              },
          },
        replyTarget: item.post!.replyTarget == null ||
            item.post!.replyTarget.actor == null
          ? null
          : {
            ...item.post!.replyTarget,
            actor: enrichActor(item.post!.replyTarget.actor, socialGraph),
          },
        quotedPost: item.post!.quotedPost == null ||
            item.post!.quotedPost.actor == null
          ? null
          : {
            ...item.post!.quotedPost,
            actor: enrichActor(item.post!.quotedPost.actor, socialGraph),
          },
      };
      result.push({
        ...item,
        post: sanitizePostActors(
          enrichedPost as unknown as typeof item.post,
        ) as unknown as TimelineEntry["post"],
        cursor: withoutShares ? item.added : item.appended,
        lastSharer: withoutShares ? null : item.lastSharer,
      });
    }

    if (needed != null && items.length < needed + ACTOR_RACE_BUFFER) break;
  }

  return result;
}
