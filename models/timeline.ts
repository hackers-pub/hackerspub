import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./db.ts";
import { getPostVisibilityFilter } from "./post.ts";
import {
  actorTable,
  followingTable,
  type NewTimelineItem,
  type Post,
  postTable,
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
              followees: {
                followeeId: post.actorId,
                accepted: { isNotNull: true },
              },
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
