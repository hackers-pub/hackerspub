import { and, eq, isNull, sql } from "drizzle-orm";
import { getOriginalArticleContent } from "./article-source.ts";
import type { Database, Transaction } from "./db.ts";
import {
  type ArticleContent,
  type ArticleSource,
  type ArticleSourceRevision,
  articleContentTable,
  articleDraftTable,
  articleSourceRevisionTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

/**
 * Returns the most recent immutable snapshot owned by a draft, or `undefined`
 * when the draft has never had one recorded.
 *
 * This orders by `created`, which is the enclosing transaction's start time
 * and can therefore invert against lock acquisition order. Use it only to
 * detect that *some* snapshot exists (as {@link ensureSourceRevision} does),
 * never to decide which snapshot is current: that is what the authoritative
 * `article_draft.current_revision_id` pointer is for.
 */
export async function getDraftRevision(
  db: Database | Transaction,
  draftId: Uuid,
): Promise<ArticleSourceRevision | undefined> {
  return await db.query.articleSourceRevisionTable.findFirst({
    where: { articleDraftId: draftId },
    orderBy: { created: "desc", id: "desc" },
  });
}

/**
 * Returns the most recent immutable snapshot owned by a published source.
 *
 * Carries the same caveat as {@link getDraftRevision}: it is an existence
 * probe, not the current-revision pointer.
 */
export async function getSourceRevision(
  db: Database | Transaction,
  sourceId: Uuid,
): Promise<ArticleSourceRevision | undefined> {
  return await db.query.articleSourceRevisionTable.findFirst({
    where: { sourceId },
    orderBy: { created: "desc", id: "desc" },
  });
}

/**
 * Returns the source revision the original-language content currently
 * corresponds to.
 *
 * The original `article_content` row is authoritative: its `sourceRevisionId`
 * points at the snapshot matching its current title/body, and it is written
 * under the `article_source` row lock. It can be `null` for a legacy row that
 * predates revision tracking, which callers must read as an unknown baseline
 * rather than guessing at the newest snapshot; callers that need a usable
 * baseline on a write path should use {@link ensureSourceRevision}.
 */
export async function getCurrentSourceRevision(
  db: Database | Transaction,
  sourceId: Uuid,
): Promise<ArticleSourceRevision | undefined> {
  const original = await getOriginalArticleContent(db, {
    id: sourceId,
  } as ArticleSource);
  if (original?.sourceRevisionId == null) return undefined;
  return await db.query.articleSourceRevisionTable.findFirst({
    where: { id: original.sourceRevisionId },
  });
}

/**
 * Returns the snapshot a draft's current title/body/language corresponds to,
 * following the authoritative `article_draft.current_revision_id` pointer.
 */
export async function getCurrentDraftRevision(
  db: Database | Transaction,
  draftId: Uuid,
): Promise<ArticleSourceRevision | undefined> {
  const draft = await db.query.articleDraftTable.findFirst({
    where: { id: draftId },
    columns: { currentRevisionId: true },
  });
  if (draft?.currentRevisionId == null) return undefined;
  return await db.query.articleSourceRevisionTable.findFirst({
    where: { id: draft.currentRevisionId },
  });
}

/**
 * Records a new draft-owned snapshot when the supplied title/body/language
 * differs from the current one, and returns the snapshot to use as the current
 * baseline.
 *
 * Saves that do not change the original reuse the current snapshot, so a
 * translation draft's baseline is never advanced merely because the original
 * was saved again. The draft's authoritative `currentRevisionId` pointer is
 * (re)written either way; every caller holds the `article_draft` row lock, so
 * the pointer never depends on timestamp ordering.
 */
export async function recordDraftRevision(
  db: Database | Transaction,
  draftId: Uuid,
  title: string,
  content: string,
  language: string,
): Promise<ArticleSourceRevision> {
  const current = await getCurrentDraftRevision(db, draftId);
  if (
    current != null &&
    current.title === title &&
    current.content === content &&
    current.language === language
  ) {
    return current;
  }
  const inserted = await db
    .insert(articleSourceRevisionTable)
    .values({
      id: generateUuidV7(),
      articleDraftId: draftId,
      sourceId: null,
      language,
      title,
      content,
    })
    .returning();
  await db
    .update(articleDraftTable)
    .set({ currentRevisionId: inserted[0].id })
    .where(eq(articleDraftTable.id, draftId));
  return inserted[0];
}

/**
 * Inserts a new snapshot for a published source from the current original
 * content and points the original row at it.
 */
export async function createSourceRevision(
  db: Database | Transaction,
  sourceId: Uuid,
  original: Pick<ArticleContent, "language" | "title" | "content">,
): Promise<ArticleSourceRevision> {
  const inserted = await db
    .insert(articleSourceRevisionTable)
    .values({
      id: generateUuidV7(),
      articleDraftId: null,
      sourceId,
      language: original.language,
      title: original.title,
      content: original.content,
    })
    .returning();
  await db
    .update(articleContentTable)
    .set({ sourceRevisionId: inserted[0].id })
    .where(
      and(
        eq(articleContentTable.sourceId, sourceId),
        isNull(articleContentTable.originalLanguage),
      ),
    );
  return inserted[0];
}

/**
 * Returns the current snapshot for a published source, creating one from the
 * original content when revision tracking has not yet recorded any (legacy
 * rows, or a source whose original was written before this feature).
 *
 * Write path only: a read must never create a snapshot, because that would
 * turn an unknown baseline into a fabricated one.
 */
export async function ensureSourceRevision(
  db: Database | Transaction,
  sourceId: Uuid,
): Promise<ArticleSourceRevision | undefined> {
  const current = await getCurrentSourceRevision(db, sourceId);
  if (current != null) return current;
  const original = await getOriginalArticleContent(db, {
    id: sourceId,
  } as ArticleSource);
  if (original == null) return undefined;
  // A legacy source may already own snapshots without the original row
  // pointing at one. Adopt the newest instead of duplicating it.
  const existing = await getSourceRevision(db, sourceId);
  if (
    existing != null &&
    existing.language === original.language &&
    existing.title === original.title &&
    existing.content === original.content
  ) {
    await db
      .update(articleContentTable)
      .set({ sourceRevisionId: existing.id })
      .where(
        and(
          eq(articleContentTable.sourceId, sourceId),
          isNull(articleContentTable.originalLanguage),
        ),
      );
    return existing;
  }
  return await createSourceRevision(db, sourceId, original);
}

/**
 * Returns a SQL expression for the published source's current revision id,
 * but only when its `(language, title, content)` is exactly the text passed
 * in; otherwise `NULL`.
 *
 * Automatic translation jobs use it to stamp the baseline their output was
 * produced from without taking the `article_source` lock. The comparison lives
 * inside the same statement that writes the placeholder, so there is no
 * read-then-write window: if the original moved between the caller's read and
 * this write, the texts no longer match and the job records an unknown
 * baseline instead of falsely claiming to be current with a revision it never
 * translated.
 */
export function matchingSourceRevisionSql(
  sourceId: Uuid,
  text: { language: string; title: string; content: string },
) {
  return sql`(
    SELECT ${articleSourceRevisionTable.id}
    FROM ${articleSourceRevisionTable}
    JOIN ${articleContentTable}
      ON ${articleContentTable.sourceRevisionId} = ${articleSourceRevisionTable.id}
      AND ${articleContentTable.sourceId} = ${sourceId}
      AND ${articleContentTable.originalLanguage} IS NULL
    WHERE ${articleSourceRevisionTable.sourceId} = ${sourceId}
      AND ${articleSourceRevisionTable.language} = ${text.language}
      AND ${articleSourceRevisionTable.title} = ${text.title}
      AND ${articleSourceRevisionTable.content} = ${text.content}
    LIMIT 1
  )`;
}
