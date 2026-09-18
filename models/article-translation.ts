import { and, eq, sql } from "drizzle-orm";
import { normalizeContentLanguage } from "./i18n.ts";
import type { StorageService } from "./context.ts";
import { type Database, runInTransaction, type Transaction } from "./db.ts";
import { canAccountActAs } from "./organization.ts";
import {
  type Account,
  articleContentTable,
  articleDraftTable,
  articleSourceTable,
  type ArticleTranslationDraft,
  articleTranslationDraftTable,
  type ArticleTranslationDraftProvenance,
} from "./schema.ts";
import {
  ensureSourceRevision,
  recordDraftRevision,
} from "./article-revision.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

export type ArticleTranslationDraftViewer = Pick<Account, "id" | "kind">;

interface TranslationOwner {
  accountId: Uuid;
  kind: "personal" | "organization";
}

export interface ArticleTranslationDraftSaveInput {
  id?: Uuid | null;
  uuid?: Uuid | null;
  articleDraftId?: Uuid | null;
  sourceId?: Uuid | null;
  language: string;
  title: string;
  content: string;
  translatorId?: Uuid | null;
  provenance?: ArticleTranslationDraftProvenance;
  revision?: number | null;
}

export type ArticleTranslationDraftSaveResult =
  | { status: "ok"; draft: ArticleTranslationDraft }
  | { status: "conflict"; currentRevision: number }
  | { status: "invalid"; inputPath: string }
  | { status: "forbidden" };

export interface ArticleTranslationDraftDeleteInput {
  id: Uuid;
  revision?: number | null;
}

export type ArticleTranslationDraftDeleteResult =
  | { status: "ok"; draftId: Uuid }
  | { status: "conflict"; currentRevision: number }
  | { status: "invalid" }
  | { status: "forbidden" };

async function lockTranslationDraft(
  db: Database | Transaction,
  draftId: Uuid,
): Promise<ArticleTranslationDraft | undefined> {
  const rows = await db
    .select()
    .from(articleTranslationDraftTable)
    .where(eq(articleTranslationDraftTable.id, draftId))
    .for("update");
  return rows[0];
}

async function resolveOwner(
  db: Database | Transaction,
  articleDraftId: Uuid | null,
  sourceId: Uuid | null,
): Promise<TranslationOwner | undefined> {
  if ((articleDraftId == null) === (sourceId == null)) return undefined;
  if (articleDraftId != null) {
    const draft = await db.query.articleDraftTable.findFirst({
      where: { id: articleDraftId },
      columns: { accountId: true },
      with: { account: { columns: { kind: true } } },
    });
    if (draft?.account == null) return undefined;
    return { accountId: draft.accountId, kind: draft.account.kind };
  }
  const source = await db.query.articleSourceTable.findFirst({
    where: { id: sourceId! },
    columns: { accountId: true },
    with: { account: { columns: { kind: true } } },
  });
  if (source?.account == null) return undefined;
  return { accountId: source.accountId, kind: source.account.kind };
}

async function resolveTranslator(
  db: Database | Transaction,
  owner: TranslationOwner,
  viewer: ArticleTranslationDraftViewer,
  requested: Uuid | null | undefined,
): Promise<Uuid | null | "invalid"> {
  if (requested == null) {
    return owner.kind === "personal" ? owner.accountId : viewer.id;
  }
  if (owner.kind === "personal") {
    return requested === owner.accountId ? requested : "invalid";
  }
  if (requested === owner.accountId) return "invalid";
  const eligible = await canAccountActAs(
    db,
    { id: requested, kind: "personal" },
    owner.accountId,
  );
  return eligible ? requested : "invalid";
}

async function resolveOriginalLanguage(
  db: Database | Transaction,
  articleDraftId: Uuid | null,
  sourceId: Uuid | null,
): Promise<string | undefined> {
  if (articleDraftId != null) {
    const draft = await db.query.articleDraftTable.findFirst({
      where: { id: articleDraftId },
      columns: { language: true },
    });
    return draft?.language ?? undefined;
  }
  const original = await db.query.articleContentTable.findFirst({
    where: {
      sourceId: sourceId!,
      originalLanguage: { isNull: true },
    },
    columns: { language: true },
  });
  return original?.language;
}

async function automaticProvenanceAllowed(
  db: Database | Transaction,
  sourceId: Uuid | null,
  language: string,
  provenance: ArticleTranslationDraftProvenance,
): Promise<boolean> {
  if (provenance === "human") return true;
  // Pre-publication drafts have no automatic rows, so an AI-assisted draft can
  // only be seeded from a published automatic or AI-reviewed version.
  if (sourceId == null) return false;
  const rows = await db
    .select({ provenance: articleContentTable.provenance })
    .from(articleContentTable)
    .where(
      and(
        eq(articleContentTable.sourceId, sourceId),
        eq(articleContentTable.language, language),
        eq(articleContentTable.beingTranslated, false),
      ),
    );
  if (provenance === "llm") {
    return rows.some(
      (row) => row.provenance === "llm" || row.provenance === "llm_reviewed",
    );
  }
  // `unknown` reopening only preserves an existing unknown classification.
  return rows.some((row) => row.provenance === "unknown");
}

/**
 * Looks up a translation draft the viewer may access without locking it.
 * Access follows the owning draft/source (personal owner or accepted
 * organization member); `undefined` covers missing and inaccessible alike.
 */
export async function getAccessibleArticleTranslationDraft(
  db: Database | Transaction,
  viewer: ArticleTranslationDraftViewer,
  draftId: Uuid,
): Promise<ArticleTranslationDraft | undefined> {
  const draft = await db.query.articleTranslationDraftTable.findFirst({
    where: { id: draftId },
  });
  if (draft == null) return undefined;
  const owner = await resolveOwner(db, draft.articleDraftId, draft.sourceId);
  if (owner == null) return undefined;
  if (!(await canAccountActAs(db, viewer, owner.accountId))) return undefined;
  return draft;
}

/**
 * Returns the private translation draft for a language under a draft or source,
 * if one exists. Used to make **Add translation** open an existing draft rather
 * than create a duplicate.
 */
export async function getArticleTranslationDraftForLanguage(
  db: Database | Transaction,
  owner: { articleDraftId: Uuid } | { sourceId: Uuid },
  language: string,
): Promise<ArticleTranslationDraft | undefined> {
  return await db.query.articleTranslationDraftTable.findFirst({
    where: { ...owner, language },
  });
}

export async function listArticleTranslationDraftsForDraft(
  db: Database | Transaction,
  articleDraftId: Uuid,
): Promise<ArticleTranslationDraft[]> {
  return await db.query.articleTranslationDraftTable.findMany({
    where: { articleDraftId },
    orderBy: { language: "asc" },
  });
}

export async function listArticleTranslationDraftsForSource(
  db: Database | Transaction,
  sourceId: Uuid,
): Promise<ArticleTranslationDraft[]> {
  return await db.query.articleTranslationDraftTable.findMany({
    where: { sourceId },
    orderBy: { language: "asc" },
  });
}

/**
 * Resolves the media URLs a translation draft's Markdown can reference: its own
 * attachments plus the parent draft's or published source's attachments, so an
 * original image shared into a translation keeps resolving.
 */
export async function getArticleTranslationDraftMediumUrls(
  db: Database,
  disk: StorageService,
  draft: Pick<ArticleTranslationDraft, "id" | "articleDraftId" | "sourceId">,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const own = await db.query.articleTranslationDraftMediumTable.findMany({
    where: { articleTranslationDraftId: draft.id },
    with: { medium: true },
  });
  for (const relation of own) {
    result[relation.key] = await disk.getUrl(relation.medium.key);
  }
  const parents =
    draft.articleDraftId != null
      ? await db.query.articleDraftMediumTable.findMany({
          where: { articleDraftId: draft.articleDraftId },
          with: { medium: true },
        })
      : draft.sourceId != null
        ? await db.query.articleSourceMediumTable.findMany({
            where: { articleSourceId: draft.sourceId },
            with: { medium: true },
          })
        : [];
  for (const relation of parents) {
    if (relation.key in result) continue;
    result[relation.key] = await disk.getUrl(relation.medium.key);
  }
  return result;
}

/**
 * Create or update a private translation draft with optimistic concurrency.
 *
 * A translation draft is keyed by `(owner, language)`, where the owner is the
 * original draft before publication or the published source afterwards. The
 * credited translator defaults to the author for a personal original or the
 * authenticated individual for an organization, and is never changed merely by
 * saving. The baseline `sourceRevisionId` is captured at creation; a later save
 * never advances it, so publishing the draft cannot falsely claim to be current
 * with a newer original.
 *
 * A create for a language that already has a draft returns that draft unchanged
 * instead of overwriting it.
 */
export async function saveArticleTranslationDraft(
  db: Database | Transaction,
  viewer: ArticleTranslationDraftViewer,
  input: ArticleTranslationDraftSaveInput,
): Promise<ArticleTranslationDraftSaveResult> {
  const revision = input.revision ?? null;
  if (revision != null && (!Number.isInteger(revision) || revision < 1)) {
    return { status: "invalid", inputPath: "revision" };
  }
  const language = normalizeContentLanguage(input.language);
  if (language == null) return { status: "invalid", inputPath: "language" };
  const updateId = input.id ?? (revision != null ? (input.uuid ?? null) : null);
  if (input.id != null && input.uuid != null) {
    return { status: "invalid", inputPath: "uuid" };
  }
  if (input.id == null && input.uuid == null && revision != null) {
    return { status: "invalid", inputPath: "revision" };
  }
  return await runInTransaction(
    db,
    async (tx): Promise<ArticleTranslationDraftSaveResult> => {
      if (updateId != null) {
        const existing = await lockTranslationDraft(tx, updateId);
        if (existing == null) {
          return {
            status: "invalid",
            inputPath: input.id != null ? "id" : "uuid",
          };
        }
        const owner = await resolveOwner(
          tx,
          existing.articleDraftId,
          existing.sourceId,
        );
        if (owner == null) return { status: "invalid", inputPath: "id" };
        if (!(await canAccountActAs(tx, viewer, owner.accountId))) {
          return { status: "forbidden" };
        }
        if (
          input.articleDraftId != null &&
          input.articleDraftId !== existing.articleDraftId
        ) {
          return { status: "invalid", inputPath: "articleDraftId" };
        }
        if (input.sourceId != null && input.sourceId !== existing.sourceId) {
          return { status: "invalid", inputPath: "sourceId" };
        }
        if (language !== existing.language) {
          return { status: "invalid", inputPath: "language" };
        }
        if (revision != null && revision !== existing.revision) {
          return { status: "conflict", currentRevision: existing.revision };
        }
        let translatorId = existing.translatorId;
        if (input.translatorId !== undefined) {
          const resolved = await resolveTranslator(
            tx,
            owner,
            viewer,
            input.translatorId,
          );
          if (resolved === "invalid") {
            return { status: "invalid", inputPath: "translatorId" };
          }
          translatorId = resolved;
        }
        const rows = await tx
          .update(articleTranslationDraftTable)
          .set({
            title: input.title,
            content: input.content,
            translatorId,
            revision: sql`${articleTranslationDraftTable.revision} + 1`,
            updated: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            and(
              eq(articleTranslationDraftTable.id, updateId),
              revision == null
                ? undefined
                : eq(articleTranslationDraftTable.revision, revision),
            ),
          )
          .returning();
        if (rows[0] == null) {
          return { status: "conflict", currentRevision: existing.revision };
        }
        return { status: "ok", draft: rows[0] };
      }

      const hasDraft = input.articleDraftId != null;
      const hasSource = input.sourceId != null;
      if (hasDraft === hasSource) {
        return {
          status: "invalid",
          inputPath: hasDraft ? "sourceId" : "articleDraftId",
        };
      }
      // Lock the parent's identity row before reading its owner, language and
      // current snapshot. This serializes translation creation against an
      // original-language change (which locks the same row), so a translation
      // cannot be created against a language the parent is concurrently
      // changing away from.
      if (hasDraft) {
        await tx
          .select({ id: articleDraftTable.id })
          .from(articleDraftTable)
          .where(eq(articleDraftTable.id, input.articleDraftId!))
          .for("update");
      } else {
        await tx
          .select({ id: articleSourceTable.id })
          .from(articleSourceTable)
          .where(eq(articleSourceTable.id, input.sourceId!))
          .for("update");
      }
      const owner = await resolveOwner(
        tx,
        input.articleDraftId ?? null,
        input.sourceId ?? null,
      );
      if (owner == null) {
        return {
          status: "invalid",
          inputPath: hasDraft ? "articleDraftId" : "sourceId",
        };
      }
      if (!(await canAccountActAs(tx, viewer, owner.accountId))) {
        return { status: "forbidden" };
      }
      const originalLanguage = await resolveOriginalLanguage(
        tx,
        input.articleDraftId ?? null,
        input.sourceId ?? null,
      );
      if (originalLanguage == null) {
        return {
          status: "invalid",
          inputPath: hasDraft ? "articleDraftId" : "sourceId",
        };
      }
      if (normalizeContentLanguage(originalLanguage) === language) {
        return { status: "invalid", inputPath: "language" };
      }
      const existing = await getArticleTranslationDraftForLanguage(
        tx,
        hasDraft
          ? { articleDraftId: input.articleDraftId! }
          : { sourceId: input.sourceId! },
        language,
      );
      if (existing != null) {
        // Opening an existing language returns it rather than overwriting.
        return { status: "ok", draft: existing };
      }
      const provenance = input.provenance ?? "human";
      if (
        !(await automaticProvenanceAllowed(
          tx,
          input.sourceId ?? null,
          language,
          provenance,
        ))
      ) {
        return { status: "invalid", inputPath: "provenance" };
      }
      const translatorId = await resolveTranslator(
        tx,
        owner,
        viewer,
        input.translatorId,
      );
      if (translatorId === "invalid") {
        return { status: "invalid", inputPath: "translatorId" };
      }
      let baselineId: Uuid | null = null;
      if (hasDraft) {
        const draft = await tx.query.articleDraftTable.findFirst({
          where: { id: input.articleDraftId! },
          columns: { title: true, content: true },
        });
        if (draft == null) {
          return { status: "invalid", inputPath: "articleDraftId" };
        }
        const baseline = await recordDraftRevision(
          tx,
          input.articleDraftId!,
          draft.title,
          draft.content,
          originalLanguage,
        );
        baselineId = baseline.id;
      } else {
        const baseline = await ensureSourceRevision(tx, input.sourceId!);
        baselineId = baseline?.id ?? null;
      }
      const draftId = input.uuid ?? generateUuidV7();
      const inserted = await tx
        .insert(articleTranslationDraftTable)
        .values({
          id: draftId,
          articleDraftId: input.articleDraftId ?? null,
          sourceId: input.sourceId ?? null,
          language,
          title: input.title,
          content: input.content,
          translatorId,
          provenance,
          sourceRevisionId: baselineId,
          revision: 1,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) return { status: "ok", draft: inserted[0] };
      const raced = await getArticleTranslationDraftForLanguage(
        tx,
        hasDraft
          ? { articleDraftId: input.articleDraftId! }
          : { sourceId: input.sourceId! },
        language,
      );
      if (raced == null) return { status: "conflict", currentRevision: 1 };
      return { status: "ok", draft: raced };
    },
  );
}

export async function deleteArticleTranslationDraft(
  db: Database | Transaction,
  viewer: ArticleTranslationDraftViewer,
  input: ArticleTranslationDraftDeleteInput,
): Promise<ArticleTranslationDraftDeleteResult> {
  const revision = input.revision ?? null;
  if (revision != null && (!Number.isInteger(revision) || revision < 1)) {
    return { status: "invalid" };
  }
  return await runInTransaction(
    db,
    async (tx): Promise<ArticleTranslationDraftDeleteResult> => {
      const existing = await lockTranslationDraft(tx, input.id);
      if (existing == null) return { status: "invalid" };
      const owner = await resolveOwner(
        tx,
        existing.articleDraftId,
        existing.sourceId,
      );
      if (owner == null) return { status: "invalid" };
      if (!(await canAccountActAs(tx, viewer, owner.accountId))) {
        return { status: "forbidden" };
      }
      if (revision != null && revision !== existing.revision) {
        return { status: "conflict", currentRevision: existing.revision };
      }
      await tx
        .delete(articleTranslationDraftTable)
        .where(eq(articleTranslationDraftTable.id, input.id));
      return { status: "ok", draftId: input.id };
    },
  );
}
