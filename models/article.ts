import { and, eq, sql } from "drizzle-orm";
import { Database } from "../db.ts";
import {
  ArticleDraft,
  articleDraftTable,
  ArticleSource,
  articleSourceTable,
  NewArticleDraft,
  NewArticleSource,
} from "./schema.ts";
import { generateUuidV7, Uuid } from "./uuid.ts";

export async function updateArticleDraft(
  db: Database,
  draft: NewArticleDraft,
): Promise<ArticleDraft> {
  if (draft.tags != null) {
    let tags = draft.tags
      .map((tag) => tag.trim().replace(/^#\s*/, ""))
      .filter((tag) => tag !== "" && !tag.includes(","));
    tags = tags.filter((tag, index) => tags.indexOf(tag) === index);
    draft = { ...draft, tags };
  }
  const rows = await db.insert(articleDraftTable)
    .values(draft)
    .onConflictDoUpdate({
      target: [articleDraftTable.id],
      set: {
        ...draft,
        updated: sql`CURRENT_TIMESTAMP`,
        created: undefined,
      },
      setWhere: and(
        eq(articleDraftTable.id, draft.id),
        eq(articleDraftTable.accountId, draft.accountId),
      ),
    })
    .returning();
  return rows[0];
}

export async function deleteArticleDraft(
  db: Database,
  accountId: Uuid,
  draftId: Uuid,
): Promise<ArticleDraft | undefined> {
  const rows = await db.delete(articleDraftTable)
    .where(
      and(
        eq(articleDraftTable.accountId, accountId),
        eq(articleDraftTable.id, draftId),
      ),
    )
    .returning();
  return rows[0];
}

export async function createArticleSource(
  db: Database,
  source: Omit<NewArticleSource, "id"> & { id?: Uuid },
): Promise<ArticleSource | undefined> {
  const rows = await db.insert(articleSourceTable)
    .values({ id: generateUuidV7(), ...source })
    .onConflictDoNothing()
    .returning();
  return rows[0];
}
