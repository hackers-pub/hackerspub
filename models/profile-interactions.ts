import { sql } from "drizzle-orm";
import type { Database, RelationsFilter } from "./db.ts";
import { getPostVisibilityFilter } from "./post.ts";
import {
  type Account,
  type Actor,
  blockingTable,
  type Instance,
  type Mention,
  mentionTable,
  type Post,
  type PostLink,
  type PostMedium,
  type postTable,
  type Reaction,
} from "./schema.ts";
import {
  formatTimelineCursor,
  type TimelineCursor,
  type TimelineEntry,
} from "./timeline.ts";
import type { Uuid } from "./uuid.ts";

export { formatTimelineCursor, type TimelineCursor };

export interface ProfileInteractionsOptions {
  readonly viewer: Account & { actor: Actor };
  readonly profileActorId: Uuid;
  readonly direction?: "backward" | "forward";
  readonly since?: TimelineCursor;
  readonly until?: TimelineCursor;
  readonly window?: number;
}

function getPostCursorFilter(
  cursor: TimelineCursor,
  boundary: "newer" | "older",
): RelationsFilter<"postTable"> {
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

function getDirectInteractionFilter(
  viewerActorId: Uuid,
  profileActorId: Uuid,
): RelationsFilter<"postTable"> {
  return {
    RAW: (post: typeof postTable) =>
      sql`
      ${post.sharedPostId} IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM ${blockingTable}
        WHERE (
          ${blockingTable.blockerId} = ${viewerActorId}::uuid
          AND ${blockingTable.blockeeId} = ${profileActorId}::uuid
        )
        OR (
          ${blockingTable.blockerId} = ${profileActorId}::uuid
          AND ${blockingTable.blockeeId} = ${viewerActorId}::uuid
        )
      )
      AND (
        (
          ${post.actorId} = ${viewerActorId}::uuid
          AND (
            EXISTS (
              SELECT 1
              FROM "post" "reply_target"
              WHERE "reply_target"."id" = ${post.replyTargetId}
                AND "reply_target"."actor_id" = ${profileActorId}::uuid
            )
            OR EXISTS (
              SELECT 1
              FROM "post" "quoted_post"
              WHERE "quoted_post"."id" = ${post.quotedPostId}
                AND "quoted_post"."actor_id" = ${profileActorId}::uuid
            )
            OR EXISTS (
              SELECT 1
              FROM ${mentionTable}
              WHERE ${mentionTable.postId} = ${post.id}
                AND ${mentionTable.actorId} = ${profileActorId}::uuid
            )
          )
        )
        OR (
          ${post.actorId} = ${profileActorId}::uuid
          AND (
            EXISTS (
              SELECT 1
              FROM "post" "reply_target"
              WHERE "reply_target"."id" = ${post.replyTargetId}
                AND "reply_target"."actor_id" = ${viewerActorId}::uuid
            )
            OR EXISTS (
              SELECT 1
              FROM "post" "quoted_post"
              WHERE "quoted_post"."id" = ${post.quotedPostId}
                AND "quoted_post"."actor_id" = ${viewerActorId}::uuid
            )
            OR EXISTS (
              SELECT 1
              FROM ${mentionTable}
              WHERE ${mentionTable.postId} = ${post.id}
                AND ${mentionTable.actorId} = ${viewerActorId}::uuid
            )
          )
        )
      )
    `,
  };
}

// Mirrors the timeline helpers: nullable post relations whose actor vanished
// between Drizzle's relation queries are hidden, and broken mention actors are
// dropped so GraphQL does not fail non-null nested actor fields.
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

type InteractionPost = Post & {
  actor: Actor & { instance: Instance };
  link: PostLink & { creator?: Actor | null } | null;
  sharedPost:
    | Post & {
      actor: Actor & { instance: Instance };
      link: PostLink & { creator?: Actor | null } | null;
      replyTarget:
        | Post & {
          actor: Actor & { instance: Instance };
          link: PostLink & { creator?: Actor | null } | null;
          mentions: (Mention & { actor: Actor })[];
          media: PostMedium[];
        }
        | null;
      quotedPost:
        | Post & {
          actor: Actor & { instance: Instance };
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
      actor: Actor & { instance: Instance };
      link: PostLink & { creator?: Actor | null } | null;
      mentions: (Mention & { actor: Actor })[];
      media: PostMedium[];
    }
    | null;
  quotedPost:
    | Post & {
      actor: Actor & { instance: Instance };
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

function toTimelinePost(post: InteractionPost): TimelineEntry["post"] {
  return post as unknown as TimelineEntry["post"];
}

export async function getProfileInteractions(
  db: Database,
  {
    viewer,
    profileActorId,
    direction = "forward",
    since,
    until,
    window,
  }: ProfileInteractionsOptions,
): Promise<TimelineEntry[]> {
  if (viewer.actor.id === profileActorId) return [];

  const cursorFilters = [
    since == null ? undefined : getPostCursorFilter(since, "newer"),
    until == null ? undefined : getPostCursorFilter(until, "older"),
  ].filter((f) => f != null);
  const limit = window == null ? undefined : window;
  const filter: RelationsFilter<"postTable"> = {
    AND: [
      getPostVisibilityFilter(viewer.actor),
      getDirectInteractionFilter(viewer.actor.id, profileActorId),
      ...cursorFilters,
    ],
  };

  const candidatePosts = await db.query.postTable.findMany({
    columns: {
      id: true,
      published: true,
    },
    where: filter,
    orderBy: (post, { asc, desc }) => {
      const cursorTimestamp = sql<Date>`${post.published}::timestamptz(3)`;
      return [
        direction === "backward" ? asc(cursorTimestamp) : desc(cursorTimestamp),
        direction === "backward" ? asc(post.id) : desc(post.id),
      ];
    },
    limit,
  });

  if (candidatePosts.length < 1) return [];

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
            where: { actorId: viewer.actor.id },
          },
          reactions: {
            where: { actorId: viewer.actor.id },
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
        where: { actorId: viewer.actor.id },
      },
      reactions: {
        where: { actorId: viewer.actor.id },
      },
    },
    where: {
      AND: [
        { id: { in: candidatePostIds } },
        getPostVisibilityFilter(viewer.actor),
      ],
    },
  });
  posts.sort((a, b) =>
    (candidateOrder.get(a.id as Uuid) ?? Number.MAX_SAFE_INTEGER) -
    (candidateOrder.get(b.id as Uuid) ?? Number.MAX_SAFE_INTEGER)
  );

  const result: TimelineEntry[] = [];
  for (const post of posts) {
    if (post.actor == null) continue;
    const sanitizedPost = sanitizePostActors(post) as InteractionPost;
    result.push({
      post: toTimelinePost(sanitizedPost),
      lastSharer: null,
      sharersCount: 0,
      added: post.published,
      cursor: post.published,
    });
  }
  return result;
}
