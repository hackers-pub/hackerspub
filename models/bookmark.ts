import { and, desc, eq, lte } from "drizzle-orm";
import type { Database } from "./db.ts";
import {
  type Account,
  type Bookmark,
  bookmarkTable,
  type Post,
  postTable,
  type PostType,
} from "./schema.ts";

export async function createBookmark(
  db: Database,
  account: Account,
  post: Post,
): Promise<Bookmark> {
  const [row] = await db
    .insert(bookmarkTable)
    .values({ accountId: account.id, postId: post.id })
    .onConflictDoNothing()
    .returning();
  if (row != null) return row;
  const existing = await db.query.bookmarkTable.findFirst({
    where: {
      accountId: account.id,
      postId: post.id,
    },
  });
  return existing!;
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

export async function isPostBookmarkedBy(
  db: Database,
  post: Post,
  account?: Account | null,
): Promise<boolean> {
  if (account == null) return false;
  const rows = await db
    .select({ postId: bookmarkTable.postId })
    .from(bookmarkTable)
    .where(
      and(
        eq(bookmarkTable.accountId, account.id),
        eq(bookmarkTable.postId, post.id),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export interface BookmarkListOptions {
  readonly account: Account;
  readonly postType?: PostType;
  readonly until?: Date;
  readonly window: number;
}

export interface BookmarkEntry {
  readonly post: Post;
  readonly bookmarkedAt: Date;
}

export async function getBookmarks(
  db: Database,
  { account, postType, until, window }: BookmarkListOptions,
): Promise<BookmarkEntry[]> {
  const rows = await db
    .select({
      post: postTable,
      bookmarkedAt: bookmarkTable.created,
    })
    .from(bookmarkTable)
    .innerJoin(postTable, eq(bookmarkTable.postId, postTable.id))
    .where(
      and(
        eq(bookmarkTable.accountId, account.id),
        postType == null ? undefined : eq(postTable.type, postType),
        until == null ? undefined : lte(bookmarkTable.created, until),
      ),
    )
    .orderBy(desc(bookmarkTable.created))
    .limit(window);
  return rows.map((row) => ({
    post: row.post,
    bookmarkedAt: row.bookmarkedAt,
  }));
}
