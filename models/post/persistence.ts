import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { ApplicationContext } from "../context.ts";
import type { Database } from "../db.ts";
import { stripHtml } from "../html.ts";
import {
  createQuotedPostUpdatedNotification,
  createSharedPostUpdatedNotification,
} from "../notification.ts";
import {
  type Actor,
  actorTable,
  type NewPostLink,
  type Post,
  type PostLink,
  postLinkTable,
  postTable,
  quoteRequestTable,
} from "../schema.ts";
import { generateUuidV7, type Uuid } from "../uuid.ts";

const ARTICLE_LINK_DESCRIPTION_MAX_LENGTH = 500;

type PostUpdateComparison = Pick<
  Post,
  "id" | "actorId" | "name" | "contentHtml" | "updated"
>;

function hasNotifiablePostContentChange(
  previousPost: Pick<Post, "name" | "contentHtml"> | undefined,
  updatedPost: Pick<Post, "name" | "contentHtml">,
): boolean {
  return previousPost != null &&
    (previousPost.name !== updatedPost.name ||
      previousPost.contentHtml !== updatedPost.contentHtml);
}

function isHttpUrl(value: string | undefined | null): value is string {
  if (value == null) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function truncatePlainText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= ARTICLE_LINK_DESCRIPTION_MAX_LENGTH) return text;
  return `${
    text.slice(0, ARTICLE_LINK_DESCRIPTION_MAX_LENGTH - 3).trimEnd()
  }...`;
}

export async function persistArticleNewsLink(
  fedCtx: ApplicationContext,
  article: {
    readonly url: string | null | undefined;
    readonly iri: string;
    readonly name: string | null | undefined;
    readonly summary: string | null | undefined;
    readonly contentHtml: string | null | undefined;
  },
  actor: Pick<Actor, "id" | "name" | "username">,
): Promise<PostLink | undefined> {
  const url = isHttpUrl(article.url) ? article.url : article.iri;
  if (!isHttpUrl(url)) return undefined;
  const parsed = new URL(url);
  const description = article.summary == null || article.summary.trim() === ""
    ? article.contentHtml == null
      ? undefined
      : truncatePlainText(stripHtml(article.contentHtml))
    : truncatePlainText(stripHtml(article.summary));
  const author = actor.name == null || actor.name.trim() === ""
    ? actor.username
    : actor.name;
  const values: NewPostLink = {
    id: generateUuidV7(),
    url: parsed.href,
    title: article.name ?? undefined,
    siteName: parsed.host,
    type: "article",
    description,
    author,
    creatorId: actor.id,
  };
  const rows = await fedCtx.db
    .insert(postLinkTable)
    .values(values)
    .onConflictDoUpdate({
      target: postLinkTable.url,
      set: {
        title: values.title,
        siteName: values.siteName,
        type: values.type,
        description: values.description,
        author: values.author,
        creatorId: values.creatorId,
        scraped: sql`CURRENT_TIMESTAMP`,
      },
      setWhere: eq(postLinkTable.url, values.url),
    })
    .returning();
  return rows[0];
}

export async function createTargetPostUpdatedNotifications(
  db: Database,
  previousPost: Pick<Post, "name" | "contentHtml"> | undefined,
  updatedPost: PostUpdateComparison,
  updatingActor: Actor,
): Promise<void> {
  if (!hasNotifiablePostContentChange(previousPost, updatedPost)) return;
  const originalAuthorAccountId = updatingActor.accountId;
  const shouldNotifyAccount = (
    accountId: Uuid | null,
  ): accountId is Uuid =>
    accountId != null && accountId !== originalAuthorAccountId;

  const shareRows = await db
    .select({ accountId: actorTable.accountId })
    .from(postTable)
    .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
    .where(and(
      eq(postTable.sharedPostId, updatedPost.id),
      isNotNull(actorTable.accountId),
    ));
  const sharingAccountIds = new Set(
    shareRows.map((row) => row.accountId).filter(shouldNotifyAccount),
  );
  for (const accountId of sharingAccountIds) {
    await createSharedPostUpdatedNotification(
      db,
      accountId,
      updatedPost,
      updatingActor,
    );
  }

  const directQuoteRows = await db
    .select({ accountId: actorTable.accountId })
    .from(postTable)
    .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
    .where(and(
      eq(postTable.quotedPostId, updatedPost.id),
      isNotNull(actorTable.accountId),
    ));
  const quoteRequestRows = await db
    .select({ accountId: actorTable.accountId })
    .from(quoteRequestTable)
    .innerJoin(postTable, eq(postTable.id, quoteRequestTable.quotePostId))
    .innerJoin(actorTable, eq(actorTable.id, postTable.actorId))
    .where(and(
      eq(quoteRequestTable.quotedPostId, updatedPost.id),
      isNull(quoteRequestTable.accepted),
      isNull(quoteRequestTable.rejected),
      isNotNull(actorTable.accountId),
    ));
  const quotingAccountIds = new Set(
    [...directQuoteRows, ...quoteRequestRows]
      .map((row) => row.accountId)
      .filter(shouldNotifyAccount),
  );
  for (const accountId of quotingAccountIds) {
    await createQuotedPostUpdatedNotification(
      db,
      accountId,
      updatedPost,
      updatingActor,
    );
  }
}
