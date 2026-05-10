import { and, asc, desc, eq, gt, inArray, lt, or } from "drizzle-orm";
import type { Database } from "./db.ts";
import {
  type Account,
  type Bookmark,
  bookmarkTable,
  type Post,
  postTable,
  type PostType,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

export async function createBookmark(
  db: Database,
  account: Account,
  post: Post,
): Promise<Bookmark> {
  const [row] = await db
    .insert(bookmarkTable)
    .values({ accountId: account.id, postId: post.id })
    .onConflictDoUpdate({
      target: [bookmarkTable.accountId, bookmarkTable.postId],
      set: { accountId: account.id },
    })
    .returning();
  return row;
}

export async function deleteBookmark(
  db: Database,
  account: Account,
  post: Post,
): Promise<Bookmark | null> {
  const [row] = await db
    .delete(bookmarkTable)
    .where(
      and(
        eq(bookmarkTable.accountId, account.id),
        eq(bookmarkTable.postId, post.id),
      ),
    )
    .returning();
  return row ?? null;
}

export async function arePostsBookmarkedBy(
  db: Database,
  postIds: readonly Uuid[],
  account: Account,
): Promise<Set<Uuid>> {
  if (postIds.length < 1) return new Set();
  const rows = await db
    .select({ postId: bookmarkTable.postId })
    .from(bookmarkTable)
    .where(
      and(
        eq(bookmarkTable.accountId, account.id),
        inArray(bookmarkTable.postId, postIds as Uuid[]),
      ),
    );
  return new Set(rows.map((row) => row.postId));
}

export interface BookmarkCursor {
  readonly created: Date;
  readonly postId: Uuid;
}

export interface BookmarkListOptions {
  readonly account: Account;
  readonly direction?: "backward" | "forward";
  readonly postType?: PostType;
  readonly since?: BookmarkCursor;
  readonly until?: BookmarkCursor;
  readonly window: number;
}

export interface BookmarkEntry {
  readonly post: Post;
  readonly bookmarked: Date;
}

export async function getBookmarks(
  db: Database,
  {
    account,
    direction = "forward",
    postType,
    since,
    until,
    window,
  }: BookmarkListOptions,
): Promise<BookmarkEntry[]> {
  const rows = await db
    .select({
      post: postTable,
      bookmarked: bookmarkTable.created,
    })
    .from(bookmarkTable)
    .innerJoin(postTable, eq(bookmarkTable.postId, postTable.id))
    .where(
      and(
        eq(bookmarkTable.accountId, account.id),
        postType == null ? undefined : eq(postTable.type, postType),
        since == null ? undefined : or(
          gt(bookmarkTable.created, since.created),
          and(
            eq(bookmarkTable.created, since.created),
            gt(bookmarkTable.postId, since.postId),
          ),
        ),
        until == null ? undefined : or(
          lt(bookmarkTable.created, until.created),
          and(
            eq(bookmarkTable.created, until.created),
            lt(bookmarkTable.postId, until.postId),
          ),
        ),
      ),
    )
    .orderBy(
      direction === "backward"
        ? asc(bookmarkTable.created)
        : desc(bookmarkTable.created),
      direction === "backward"
        ? asc(bookmarkTable.postId)
        : desc(bookmarkTable.postId),
    )
    .limit(window);
  return rows.map((row) => ({
    post: row.post,
    bookmarked: row.bookmarked,
  }));
}
