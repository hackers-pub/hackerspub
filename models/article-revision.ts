import { and, eq, isNull } from "drizzle-orm";
import { getOriginalArticleContent } from "./article-source.ts";
import type { Database, Transaction } from "./db.ts";
import {
  type ArticleContent,
  type ArticleSource,
  type ArticleSourceRevision,
  articleContentTable,
  articleSourceRevisionTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

/**
 * Returns the most recent immutable snapshot owned by a draft, or `undefined`
 * when the draft has never had one recorded.
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
 * Returns the most recent immutable snapshot owned by a published source, or
 * `undefined` for a legacy source that predates revision tracking.
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
 * points at the snapshot matching its current title/body. It can be `null` for
 * a legacy row before backfill; callers that need a usable baseline should use
 * {@link ensureSourceRevision}.
 */
export async function getCurrentSourceRevision(
  db: Database | Transaction,
  sourceId: Uuid,
): Promise<ArticleSourceRevision | undefined> {
  const original = await getOriginalArticleContent(db, {
    id: sourceId,
  } as ArticleSource);
  if (original?.sourceRevisionId != null) {
    const revision = await db.query.articleSourceRevisionTable.findFirst({
      where: { id: original.sourceRevisionId },
    });
    if (revision != null) return revision;
  }
  return await getSourceRevision(db, sourceId);
}

/**
 * Records a new draft-owned snapshot when the supplied title/body/language
 * differs from the latest one, and returns the snapshot to use as the current
 * baseline.
 *
 * Saves that do not change the original reuse the latest snapshot, so a
 * translation draft's baseline is never advanced merely because the original
 * was saved again.
 */
export async function recordDraftRevision(
  db: Database | Transaction,
  draftId: Uuid,
  title: string,
  content: string,
  language: string,
): Promise<ArticleSourceRevision> {
  const latest = await getDraftRevision(db, draftId);
  if (
    latest != null &&
    latest.title === title &&
    latest.content === content &&
    latest.language === language
  ) {
    return latest;
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
  return await createSourceRevision(db, sourceId, original);
}
