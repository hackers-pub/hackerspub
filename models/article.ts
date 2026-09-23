import * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import type { ApplicationModel } from "./context.ts";
import {
  and,
  eq,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import postgres from "postgres";
export {
  getArticleDraftMediumUrls,
  getArticleSourceMediumUrls,
  getOriginalArticleContent,
} from "./article-source.ts";
import { getOriginalArticleContent } from "./article-source.ts";
import type { ApplicationContext, Models } from "./context.ts";
import { type Database, runInTransaction, type Transaction } from "./db.ts";
import { assertAccountActorNotSuspended } from "./moderation.ts";
import { canAccountActAs } from "./organization.ts";
import { recordArticlePublication } from "./article-analytics.ts";
import { transactional, withTransaction } from "./tx.ts";
import { syncPostFromArticleSource } from "./post/source.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  accountTable,
  type Actor,
  type ArticleContent,
  type ArticleContentProvenance,
  articleContentTable,
  type ArticleDraft,
  articleDraftTable,
  type ArticleSource,
  articleSourceMediumTable,
  type ArticleSourceRevision,
  articleSourceRevisionTable,
  articleSourceTable,
  type ArticleTranslationDraft,
  articleTranslationDraftMediumTable,
  articleTranslationDraftTable,
  type Blocking,
  type Following,
  type Instance,
  type Mention,
  type NewArticleSource,
  type Post,
  postTable,
  type Reaction,
} from "./schema.ts";
import type { AiServices } from "./services.ts";
import { removeDetailsFromSummaryInput } from "./summary.ts";
import { addPostToTimeline } from "./timeline.ts";
import { queueAfterCommit } from "./tx.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";
import {
  createSourceRevision,
  ensureSourceRevision,
  matchingSourceRevisionSql,
  recordDraftRevision,
} from "./article-revision.ts";
import {
  acknowledgeArticleTranslationSource,
  type AcknowledgeArticleTranslationSourceInput,
  type AcknowledgeArticleTranslationSourceResult,
  isTranslationReviewPushStillValid,
  type PendingTranslationReviewPush,
  syncTranslationReviewNotifications,
} from "./article-translation-review.ts";
import {
  lockArticleSource,
  nextArticleVersionSql,
  publishArticleState,
  syncArticleContentVariants,
  syncArticleContentVariantSummary,
} from "./article-publication.ts";
import { getArticleReferenceTime } from "./article-translation-metadata.ts";
import { normalizeContentLanguage } from "./i18n.ts";
import { sendNotificationPush } from "./notification.ts";

const logger = getLogger(["hackerspub", "models", "article"]);
const articleMediumReferencePattern = /hp-medium:([A-Za-z0-9._:/-]+)/g;
const articleMediumKeyPattern = /^[A-Za-z0-9._:/-]+$/;

interface ArticleMediumInput {
  key: string;
  mediumId: Uuid;
}

interface CreateArticleSourceOptions {
  summarize?: boolean;
}

interface CreatePostOptions {
  afterPostCreated?: (post: Post, db: Database | Transaction) => Promise<void>;
}

class InvalidArticleSourceMediumError extends Error {}

function extractArticleMediumKeys(content: string): Set<string> {
  return new Set(
    [...content.matchAll(articleMediumReferencePattern)].map(
      (match) => match[1],
    ),
  );
}

async function updateArticleSourceMedia(
  db: Database | Transaction,
  articleSourceId: Uuid,
  content: string,
  retainedContents: readonly string[],
  sourceMedia: readonly ArticleMediumInput[] | undefined,
): Promise<boolean> {
  // Only the original body is *validated*: it is the surface the caller
  // controls and whose missing media should fail the update. `retainedContents`
  // (published translations and live private drafts) only widen the delete
  // filter, so a key that survives there is never pruned, but a stray key a
  // translator typed does not block the original from being edited.
  const referencedMediumKeys = extractArticleMediumKeys(content);
  const retainedMediumKeys = new Set(referencedMediumKeys);
  for (const retained of retainedContents) {
    for (const key of extractArticleMediumKeys(retained)) {
      retainedMediumKeys.add(key);
    }
  }
  const existingMedia = await db.query.articleSourceMediumTable.findMany({
    where: { articleSourceId },
  });
  const existingMediaByKey = new Map(
    existingMedia.map((medium) => [medium.key, medium]),
  );
  const sourceMediaByKey = new Map<string, ArticleMediumInput>();
  for (const medium of sourceMedia ?? []) {
    if (!articleMediumKeyPattern.test(medium.key)) return false;
    sourceMediaByKey.set(medium.key, medium);
  }
  const missingKeys = [...referencedMediumKeys].filter(
    (key) => !existingMediaByKey.has(key) && !sourceMediaByKey.has(key),
  );
  if (missingKeys.length > 0) return false;
  const referencedSourceMedia = [...referencedMediumKeys]
    .map((key) => sourceMediaByKey.get(key))
    .filter((medium) => medium != null);
  const referencedMediumIds = [
    ...new Set(referencedSourceMedia.map((medium) => medium.mediumId)),
  ];
  if (referencedMediumIds.length > 0) {
    const storedMedia = await db.query.mediumTable.findMany({
      where: { id: { in: referencedMediumIds } },
      columns: { id: true },
    });
    if (storedMedia.length !== referencedMediumIds.length) return false;
  }
  if (retainedMediumKeys.size < 1) {
    await db
      .delete(articleSourceMediumTable)
      .where(eq(articleSourceMediumTable.articleSourceId, articleSourceId));
  } else {
    await db
      .delete(articleSourceMediumTable)
      .where(
        and(
          eq(articleSourceMediumTable.articleSourceId, articleSourceId),
          notInArray(articleSourceMediumTable.key, [...retainedMediumKeys]),
        ),
      );
  }
  if (referencedSourceMedia.length > 0) {
    await db
      .insert(articleSourceMediumTable)
      .values(
        referencedSourceMedia.map((medium) => ({
          articleSourceId,
          key: medium.key,
          mediumId: medium.mediumId,
        })),
      )
      // A published key-to-medium mapping is immutable: a later private edit
      // that reuses the same key with a different medium must not rebind the
      // already-public image.
      .onConflictDoNothing();
  }
  return true;
}

/**
 * Counts the number of user-perceived characters (extended grapheme
 * clusters) in a string.
 *
 * `String.prototype.length` returns the number of UTF-16 code units,
 * so non-BMP characters such as emoji count as 2 and a single emoji
 * family (e.g. 👨‍👩‍👧) counts as several.  Comparing summary and
 * article body lengths in code units therefore lets a "longer" emoji
 * heavy summary slip past the discard guard.  Counting graphemes via
 * `Intl.Segmenter` matches what a reader actually perceives as
 * "shorter".
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemeCount(text: string): number {
  let count = 0;
  for (const _ of graphemeSegmenter.segment(text)) count++;
  return count;
}

export class LanguageChangeWithTranslationsError extends Error {
  constructor() {
    super("Cannot change language when translations already exist");
    this.name = "LanguageChangeWithTranslationsError";
  }
}

export type ArticleDraftViewer = Pick<Account, "id" | "kind">;

export interface ArticleDraftSaveInput {
  id?: Uuid | null;
  uuid?: Uuid | null;
  actingAccountId?: Uuid | null;
  title: string;
  content: string;
  language?: string | null;
  tags: readonly string[];
  revision?: number | null;
}

export type ArticleDraftSaveResult =
  | { status: "ok"; draft: ArticleDraft }
  | { status: "conflict"; currentRevision: number }
  | { status: "invalid"; inputPath: string }
  | { status: "forbidden" };

export interface ArticleDraftDeleteInput {
  id: Uuid;
  revision?: number | null;
}

export type ArticleDraftDeleteResult =
  | { status: "ok"; draftId: Uuid }
  | { status: "conflict"; currentRevision: number }
  | { status: "invalid" };

export interface MoveArticleDraftInput {
  id: Uuid;
  organizationAccountId: Uuid;
  revision: number;
}

export type MoveArticleDraftResult =
  | { status: "ok"; draft: ArticleDraft }
  | { status: "conflict"; currentRevision: number }
  | { status: "invalid"; inputPath: string }
  | { status: "forbidden" };

function normalizeArticleDraftTags(tags: readonly string[]): string[] {
  let normalized = tags
    .map((tag) => tag.trim().replace(/^#\s*/, ""))
    .filter((tag) => tag !== "" && !tag.includes(","));
  normalized = normalized.filter(
    (tag, index) => normalized.indexOf(tag) === index,
  );
  return normalized;
}

async function lockArticleDraft(
  db: Database | Transaction,
  draftId: Uuid,
): Promise<ArticleDraft | undefined> {
  const rows = await db
    .select()
    .from(articleDraftTable)
    .where(eq(articleDraftTable.id, draftId))
    .for("update");
  return rows[0];
}

/**
 * Look up a draft the viewer may access without locking it: the owner itself
 * (personal) or an accepted member of the owning organization. Returns
 * `undefined` both when the draft does not exist and when it is not accessible,
 * so callers never leak the existence of another workspace's draft.
 */
export async function getAccessibleArticleDraft(
  db: Database | Transaction,
  viewer: ArticleDraftViewer,
  draftId: Uuid,
): Promise<ArticleDraft | undefined> {
  const draft = await db.query.articleDraftTable.findFirst({
    where: { id: draftId },
  });
  if (draft == null) return undefined;
  if (!(await canAccountActAs(db, viewer, draft.accountId))) return undefined;
  return draft;
}

/**
 * Create or update an article draft with optimistic concurrency control.
 *
 * A draft belongs to a workspace account (personal or organization) recorded in
 * `accountId`; the individual who created it is stored separately in
 * `creatorId` and never changes. Updates are conditional on the caller's
 * `revision`: a mismatch returns `status: "conflict"` with the current
 * revision instead of overwriting another contributor's work. A missing
 * `revision` on an update is accepted as an unconditional write, and a
 * revision-less save by `uuid` creates the draft or updates it if it already
 * exists, which keeps clients built before revision-based conflict checks
 * working during the rollout. Updates never insert, so a save racing a deletion
 * cannot resurrect a draft, and creation `ON CONFLICT DO NOTHING` collisions
 * are classified after an authorization check so another workspace's revision
 * is never exposed.
 */
export async function saveArticleDraft(
  db: Database | Transaction,
  viewer: ArticleDraftViewer,
  input: ArticleDraftSaveInput,
): Promise<ArticleDraftSaveResult> {
  const { id, uuid, actingAccountId, title, content, tags } = input;
  const revision = input.revision ?? null;
  if (id != null && uuid != null) {
    return { status: "invalid", inputPath: "uuid" };
  }
  if (revision != null && (!Number.isInteger(revision) || revision < 1)) {
    return { status: "invalid", inputPath: "revision" };
  }
  const updateId = id ?? (revision != null ? (uuid ?? null) : null);
  if (id == null && uuid == null && revision != null) {
    return { status: "invalid", inputPath: "revision" };
  }
  const normalizedTags = normalizeArticleDraftTags(tags);
  const requestedLanguage =
    input.language == null
      ? undefined
      : normalizeContentLanguage(input.language);
  if (input.language != null && requestedLanguage == null) {
    return { status: "invalid", inputPath: "language" };
  }
  return await runInTransaction(
    db,
    async (tx): Promise<ArticleDraftSaveResult> => {
      if (updateId != null) {
        const inputPath = id != null ? "id" : "uuid";
        const existing = await lockArticleDraft(tx, updateId);
        if (existing == null) return { status: "invalid", inputPath };
        if (!(await canAccountActAs(tx, viewer, existing.accountId))) {
          return { status: "invalid", inputPath };
        }
        if (actingAccountId != null && actingAccountId !== existing.accountId) {
          return { status: "invalid", inputPath: "actingAccountId" };
        }
        if (revision != null && revision !== existing.revision) {
          return { status: "conflict", currentRevision: existing.revision };
        }
        const effectiveLanguage = requestedLanguage ?? existing.language;
        if (
          existing.language != null &&
          requestedLanguage != null &&
          requestedLanguage !== existing.language
        ) {
          // Changing the original language after translations exist would
          // silently reinterpret every translation's baseline, so it is
          // rejected rather than applied.
          const translations = await tx
            .select({ id: articleTranslationDraftTable.id })
            .from(articleTranslationDraftTable)
            .where(eq(articleTranslationDraftTable.articleDraftId, updateId))
            .limit(1);
          if (translations.length > 0) {
            return { status: "invalid", inputPath: "language" };
          }
        }
        const rows = await tx
          .update(articleDraftTable)
          .set({
            title,
            content,
            tags: normalizedTags,
            language: effectiveLanguage,
            revision: sql`${articleDraftTable.revision} + 1`,
            updated: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            and(
              eq(articleDraftTable.id, updateId),
              revision == null
                ? undefined
                : eq(articleDraftTable.revision, revision),
            ),
          )
          .returning();
        if (rows[0] == null) {
          return { status: "conflict", currentRevision: existing.revision };
        }
        if (effectiveLanguage != null) {
          await recordDraftRevision(
            tx,
            updateId,
            title,
            content,
            effectiveLanguage,
          );
        }
        return { status: "ok", draft: rows[0] };
      }
      const draftId = uuid ?? generateUuidV7();
      let workspaceId: Uuid;
      if (actingAccountId == null) {
        if (viewer.kind !== "personal") return { status: "forbidden" };
        workspaceId = viewer.id;
      } else {
        if (!(await canAccountActAs(tx, viewer, actingAccountId))) {
          return { status: "forbidden" };
        }
        workspaceId = actingAccountId;
      }
      const inserted = await tx
        .insert(articleDraftTable)
        .values({
          id: draftId,
          accountId: workspaceId,
          creatorId: viewer.id,
          title,
          content,
          tags: normalizedTags,
          language: requestedLanguage ?? null,
          revision: 1,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0] != null) {
        if (requestedLanguage != null) {
          await recordDraftRevision(
            tx,
            draftId,
            title,
            content,
            requestedLanguage,
          );
        }
        return { status: "ok", draft: inserted[0] };
      }
      const existing = await lockArticleDraft(tx, draftId);
      if (existing == null || existing.accountId !== workspaceId) {
        return { status: "invalid", inputPath: "uuid" };
      }
      if (!(await canAccountActAs(tx, viewer, existing.accountId))) {
        return { status: "invalid", inputPath: "uuid" };
      }
      // A revision-less `uuid` save is the pre-upgrade composer's upsert: the
      // row may already exist from a media attachment, so update it instead of
      // returning a conflict the old client cannot handle.
      const upsertLanguage = requestedLanguage ?? existing.language;
      if (
        existing.language != null &&
        requestedLanguage != null &&
        requestedLanguage !== existing.language
      ) {
        const translations = await tx
          .select({ id: articleTranslationDraftTable.id })
          .from(articleTranslationDraftTable)
          .where(eq(articleTranslationDraftTable.articleDraftId, draftId))
          .limit(1);
        if (translations.length > 0) {
          return { status: "invalid", inputPath: "language" };
        }
      }
      const rows = await tx
        .update(articleDraftTable)
        .set({
          title,
          content,
          tags: normalizedTags,
          language: upsertLanguage,
          revision: sql`${articleDraftTable.revision} + 1`,
          updated: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(articleDraftTable.id, draftId))
        .returning();
      if (rows[0] == null) {
        return { status: "conflict", currentRevision: existing.revision };
      }
      if (upsertLanguage != null) {
        await recordDraftRevision(tx, draftId, title, content, upsertLanguage);
      }
      return { status: "ok", draft: rows[0] };
    },
  );
}

export async function deleteArticleDraft(
  db: Database | Transaction,
  viewer: ArticleDraftViewer,
  input: ArticleDraftDeleteInput,
): Promise<ArticleDraftDeleteResult> {
  const revision = input.revision ?? null;
  if (revision != null && (!Number.isInteger(revision) || revision < 1)) {
    return { status: "invalid" };
  }
  return await runInTransaction(
    db,
    async (tx): Promise<ArticleDraftDeleteResult> => {
      const existing = await lockArticleDraft(tx, input.id);
      if (existing == null) return { status: "invalid" };
      if (!(await canAccountActAs(tx, viewer, existing.accountId))) {
        return { status: "invalid" };
      }
      if (revision != null && revision !== existing.revision) {
        return { status: "conflict", currentRevision: existing.revision };
      }
      await tx
        .delete(articleDraftTable)
        .where(eq(articleDraftTable.id, input.id));
      return { status: "ok", draftId: input.id };
    },
  );
}

/**
 * Move a personally owned draft to an organization the viewer can post for.
 * The operation is the only way a draft's owner changes; the creator record and
 * all attached media are preserved. Organization-to-personal and
 * organization-to-organization moves are intentionally unsupported.
 */
export async function moveArticleDraftToOrganization(
  db: Database | Transaction,
  viewer: ArticleDraftViewer,
  input: MoveArticleDraftInput,
): Promise<MoveArticleDraftResult> {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    return { status: "invalid", inputPath: "revision" };
  }
  return await runInTransaction(
    db,
    async (tx): Promise<MoveArticleDraftResult> => {
      const existing = await lockArticleDraft(tx, input.id);
      if (existing == null) return { status: "invalid", inputPath: "id" };
      if (viewer.kind !== "personal" || existing.accountId !== viewer.id) {
        return { status: "invalid", inputPath: "id" };
      }
      // `articleSourceId` is currently unused, but moving a draft linked to an
      // existing source would leave its ownership inconsistent, so reject it.
      if (existing.articleSourceId != null) {
        return { status: "invalid", inputPath: "id" };
      }
      if (input.organizationAccountId === viewer.id) {
        return { status: "forbidden" };
      }
      const destination = await tx.query.accountTable.findFirst({
        where: { id: input.organizationAccountId },
        columns: { kind: true },
      });
      if (destination?.kind !== "organization") {
        return { status: "forbidden" };
      }
      if (!(await canAccountActAs(tx, viewer, input.organizationAccountId))) {
        return { status: "forbidden" };
      }
      if (existing.revision !== input.revision) {
        return { status: "conflict", currentRevision: existing.revision };
      }
      const rows = await tx
        .update(articleDraftTable)
        .set({
          accountId: input.organizationAccountId,
          revision: sql`${articleDraftTable.revision} + 1`,
          updated: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(articleDraftTable.id, input.id),
            eq(articleDraftTable.accountId, viewer.id),
            eq(articleDraftTable.revision, input.revision),
          ),
        )
        .returning();
      if (rows[0] == null) {
        return { status: "conflict", currentRevision: existing.revision };
      }
      return { status: "ok", draft: rows[0] };
    },
  );
}

export async function getArticleSource(
  db: Database,
  username: string,
  publishedYear: number,
  slug: string,
  signedAccount: (Account & { actor: Actor }) | undefined,
): Promise<
  | (ArticleSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      contents: ArticleContent[];
      post: Post & {
        actor: Actor & {
          followers: Following[];
          blockees: Blocking[];
          blockers: Blocking[];
        };
        replyTarget: Post | null;
        mentions: (Mention & { actor: Actor })[];
        shares: Post[];
        reactions: Reaction[];
      };
    })
  | undefined
> {
  if (!Number.isInteger(publishedYear)) {
    throw new TypeError(
      `The publishedYear must be an integer: ${publishedYear}`,
    );
  }
  let account = await db.query.accountTable.findFirst({
    where: { username },
  });
  if (account == null) {
    account = await db.query.accountTable.findFirst({
      where: {
        oldUsername: username,
        usernameChanged: { isNotNull: true },
      },
      orderBy: { usernameChanged: "desc" },
    });
  }
  if (account == null) return undefined;
  return await db.query.articleSourceTable.findFirst({
    with: {
      account: {
        with: { avatarMedium: true, emails: true, links: true },
      },
      contents: {
        orderBy: { published: "asc" },
      },
      post: {
        with: {
          actor: {
            with: {
              followers: true,
              blockees: true,
              blockers: true,
            },
          },
          replyTarget: true,
          mentions: {
            with: { actor: true },
          },
          shares: {
            where:
              signedAccount == null
                ? { RAW: sql`false` }
                : { actorId: signedAccount.actor.id },
          },
          reactions: {
            where:
              signedAccount == null
                ? { RAW: sql`false` }
                : { actorId: signedAccount.actor.id },
          },
        },
      },
    },
    where: {
      slug,
      publishedYear,
      accountId: account.id,
    },
  });
}

export interface ArticleAdditionalContent {
  language: string;
  title: string;
  content: string;
  originalLanguage: string;
  translatorId: Uuid | null;
  provenance: ArticleContentProvenance;
  sourceRevisionId: Uuid | null;
  /**
   * Carried over from the translation draft's own review record, so a
   * translation acknowledged before publication keeps that evidence and one
   * that was never reviewed does not acquire any.
   */
  reviewerId?: Uuid | null;
  reviewed?: Date | null;
  media?: readonly ArticleMediumInput[];
}

export async function createArticleSource(
  db: Database,
  models: Models,
  aiServices: Pick<AiServices, "summarize">,
  source: Omit<NewArticleSource, "id"> & {
    id?: Uuid;
    title: string;
    content: string;
    language: string;
    additionalContents?: readonly ArticleAdditionalContent[];
    originalRevisionId?: Uuid;
  },
  options: CreateArticleSourceOptions = {},
): Promise<(ArticleSource & { contents: ArticleContent[] }) | undefined> {
  const {
    additionalContents = [],
    originalRevisionId,
    ...articleSourceFields
  } = source;
  const sources = await db
    .insert(articleSourceTable)
    .values({ id: generateUuidV7(), ...articleSourceFields })
    .onConflictDoNothing()
    .returning();
  if (sources.length < 1) return undefined;
  // The original snapshot is created before the content rows so that the
  // original can point at it; selected translations keep the baseline they
  // were authored against.
  //
  // When the publisher already had a draft-owned snapshot with the same
  // content (the normal first-publication path), reuse it by re-parenting the
  // row to the new source instead of inserting a duplicate. Reusing the same
  // id keeps every translation draft's baseline equal to the published
  // original, so a translation published together with the original does not
  // look stale immediately.
  let originalRevisionIdToUse: Uuid | undefined;
  if (originalRevisionId != null) {
    const repointed = await db
      .update(articleSourceRevisionTable)
      .set({ sourceId: sources[0].id, articleDraftId: null })
      .where(eq(articleSourceRevisionTable.id, originalRevisionId))
      .returning();
    originalRevisionIdToUse = repointed[0]?.id;
  }
  if (originalRevisionIdToUse == null) {
    const inserted = await db
      .insert(articleSourceRevisionTable)
      .values({
        id: generateUuidV7(),
        sourceId: sources[0].id,
        language: source.language,
        title: source.title,
        content: source.content,
      })
      .returning();
    originalRevisionIdToUse = inserted[0].id;
  }
  const contents = await db
    .insert(articleContentTable)
    .values([
      {
        sourceId: sources[0].id,
        language: source.language,
        title: source.title,
        content: source.content,
        sourceRevisionId: originalRevisionIdToUse,
      },
      ...additionalContents.map((content) => ({
        sourceId: sources[0].id,
        language: content.language,
        title: content.title,
        content: content.content,
        originalLanguage: content.originalLanguage,
        translatorId: content.translatorId,
        provenance: content.provenance,
        sourceRevisionId: content.sourceRevisionId,
        reviewerId:
          content.sourceRevisionId == null
            ? null
            : (content.reviewerId ?? null),
        reviewed:
          content.sourceRevisionId == null ? null : (content.reviewed ?? null),
      })),
    ])
    .returning();
  if (options.summarize ?? true) {
    await startArticleContentSummary(
      db,
      models.summarizer,
      contents[0],
      aiServices.summarize,
    );
  }
  return { ...sources[0], contents };
}

async function queueArticleContentSummary(
  fedCtx: ApplicationContext,
  content: ArticleContent,
): Promise<void> {
  await queueAfterCommit(fedCtx, () =>
    startArticleContentSummary(
      fedCtx.rootDb ?? fedCtx.db,
      fedCtx.models.summarizer,
      content,
      fedCtx.services.ai.summarize,
    ),
  );
}

async function createArticleOperation(
  fedCtx: ApplicationContext,
  source: Omit<NewArticleSource, "id"> & {
    id?: Uuid;
    title: string;
    content: string;
    language: string;
    additionalContents?: readonly ArticleAdditionalContent[];
    originalRevisionId?: Uuid;
    media?: readonly {
      key: string;
      mediumId: Uuid;
    }[];
  },
  options: CreatePostOptions = {},
): Promise<
  | (Post & {
      actor: Actor & {
        account: Account & { emails: AccountEmail[]; links: AccountLink[] };
        instance: Instance;
      };
      articleSource: ArticleSource & {
        account: Account & { emails: AccountEmail[]; links: AccountLink[] };
        contents: ArticleContent[];
      };
    })
  | undefined
> {
  const { db } = fedCtx;
  // Check the suspension before any insert: callers without an enclosing
  // transaction would otherwise leave committed source/content rows behind
  // if the guard ran after createArticleSource.
  await assertAccountActorNotSuspended(db, source.accountId);
  const { media: sourceMedia, ...articleSourceInput } = source;
  const referencedMediumKeys = extractArticleMediumKeys(source.content);
  const sourceMediaByKey = new Map(
    (sourceMedia ?? []).map((medium) => [medium.key, medium]),
  );
  for (const key of referencedMediumKeys) {
    if (!sourceMediaByKey.has(key)) return undefined;
  }
  const articleSource = await createArticleSource(
    db,
    fedCtx.models,
    fedCtx.services.ai,
    articleSourceInput,
    { summarize: false },
  );
  if (articleSource == null) return undefined;
  const media =
    sourceMedia
      ?.filter((medium) => referencedMediumKeys.has(medium.key))
      .map((medium) => ({
        articleSourceId: articleSource.id,
        key: medium.key,
        mediumId: medium.mediumId,
      })) ?? [];
  // Selected translations may reference media that the original body does not,
  // so their attachments are promoted alongside the original's. A key that is
  // already mapped keeps its original medium (mappings are immutable).
  for (const content of articleSourceInput.additionalContents ?? []) {
    const keys = extractArticleMediumKeys(content.content);
    for (const medium of content.media ?? []) {
      if (keys.has(medium.key)) {
        media.push({
          articleSourceId: articleSource.id,
          key: medium.key,
          mediumId: medium.mediumId,
        });
      }
    }
  }
  if (media.length > 0) {
    await db
      .insert(articleSourceMediumTable)
      .values(media)
      .onConflictDoNothing();
  }
  const account = await db.query.accountTable.findFirst({
    where: { id: source.accountId },
    with: { avatarMedium: true, emails: true, links: true },
  });
  if (account == undefined) return undefined;
  const post = await syncPostFromArticleSource(fedCtx, {
    ...articleSource,
    account,
  });
  await addPostToTimeline(db, post);
  await options.afterPostCreated?.(post, db);
  // Nothing else can see the new source yet, so no lock is needed.
  await syncArticleContentVariants(fedCtx, articleSource.id);
  const articleObject = await fedCtx.services.federation.getArticle(fedCtx, {
    ...articleSource,
    account,
  });
  const activity = new vocab.Create({
    id: new URL("#create", articleObject.id ?? new URL(post.iri)),
    actor: fedCtx.getActorUri(source.accountId),
    tos: articleObject.toIds,
    ccs: articleObject.ccIds,
    object: articleObject,
  });
  await recordArticlePublication(db, {
    articleSourceId: articleSource.id,
    createActivityIri: activity.id!.href,
    actorId: post.actorId,
    published: post.published,
  });
  await fedCtx.sendActivity(
    { identifier: source.accountId },
    "followers",
    activity,
    {
      orderingKey: post.iri,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(fedCtx.canonicalOrigin)],
    },
  );
  const relayedTags = await fedCtx.services.federation.sendArticleRelayActivity(
    fedCtx,
    source.accountId,
    activity,
    {
      orderingKey: post.iri,
      visibility: post.visibility,
      accountBio: account.bio,
    },
  );
  if (relayedTags != null) {
    await db
      .update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, post.id));
    post.relayedTags = [...relayedTags];
  }
  // TODO: send Create(Article) to the mentioned actors too
  await queueArticleContentSummary(fedCtx, articleSource.contents[0]);
  return post;
}

export const createArticle = transactional(createArticleOperation);

export interface UpdateArticleSourceResult {
  source: ArticleSource & { contents: ArticleContent[] };
  /**
   * The updated original-language row that needs a fresh summary.
   * Context-aware callers use this to defer background work until commit.
   */
  resummarizeTarget?: ArticleContent;
  /**
   * `true` when the original-language `article_content` row's body
   * actually changed during this update.  The caller uses this to
   * decide whether to invalidate existing translation rows.
   *
   * Title-only edits do not set this flag, matching the existing
   * summary-invalidation gate below.
   *
   * Language changes never reach this branch when translations exist:
   * the self-FK on `article_content` (`schema.ts:524-527`) is
   * `ON DELETE CASCADE` only, so any `UPDATE … SET language = …` on
   * the original row aborts with 23503 (rethrown as
   * {@link LanguageChangeWithTranslationsError}) whenever a row's
   * `originalLanguage` references the old language.  A successful
   * `languageChanged` therefore implies zero translations and there
   * is nothing to retranslate.
   */
  originalContentChanged: boolean;
  /**
   * The snapshot recorded because the published original's title, body or
   * language actually changed, or `undefined` when this update changed only
   * metadata (tags, quote policy, the LLM translation switch) or re-saved
   * identical text.
   *
   * Unlike {@link originalContentChanged}, this also covers title-only edits,
   * which invalidate translations just as a body edit does.
   */
  sourceRevision?: ArticleSourceRevision;
}

export async function updateArticleSource(
  db: Database,
  id: Uuid,
  source: Partial<NewArticleSource> & {
    title?: string;
    content?: string;
    language?: string;
    media?: readonly ArticleMediumInput[];
  },
): Promise<UpdateArticleSourceResult | undefined> {
  const { media: sourceMedia, ...sourceFields } = source;
  // Captured inside the transaction and returned so context-aware callers can
  // enqueue fresh summarization after their enclosing transaction commits.
  let resummarizeTarget: ArticleContent | undefined;
  let originalContentChanged = false;
  // The original content row whose title/body/language changed, so a new
  // snapshot can be recorded after the update.
  let revisionTarget: ArticleContent | undefined;
  let sourceRevision: ArticleSourceRevision | undefined;
  let result: (ArticleSource & { contents: ArticleContent[] }) | undefined;
  try {
    result = await db.transaction(async (tx) => {
      // Read the object's reference timestamp under the row lock before
      // moving it: if this edit supersedes the original's revision, that is
      // the last `sourceUpdated` peers were told for translations current
      // against it, and it is recorded on the old revision below.
      const previous = await tx
        .select({
          updated: articleSourceTable.updated,
          published: articleSourceTable.published,
        })
        .from(articleSourceTable)
        .where(eq(articleSourceTable.id, id))
        .for("update");
      if (previous.length < 1) return undefined;
      const sources = await tx
        .update(articleSourceTable)
        .set({ ...sourceFields, updated: nextArticleVersionSql() })
        .where(eq(articleSourceTable.id, id))
        .returning();
      if (sources.length < 1) return undefined;
      const originalContent = await getOriginalArticleContent(tx, sources[0]);
      const previousRevisionId = originalContent?.sourceRevisionId ?? null;
      if (originalContent == null) {
        if (
          sourceFields.language == null ||
          sourceFields.title == null ||
          sourceFields.content == null
        ) {
          throw new Error("Missing required fields for new article content");
        }
        const inserted = await tx
          .insert(articleContentTable)
          .values({
            sourceId: id,
            language: sourceFields.language,
            title: sourceFields.title,
            content: sourceFields.content,
          })
          .returning();
        revisionTarget = inserted[0];
      } else {
        const newContent = sourceFields.content ?? originalContent.content;
        const newLanguage = sourceFields.language ?? originalContent.language;
        const newTitle = sourceFields.title ?? originalContent.title;
        const contentChanged = newContent !== originalContent.content;
        const titleChanged = newTitle !== originalContent.title;
        const languageChanged = newLanguage !== originalContent.language;
        try {
          const updatedRows = await tx
            .update(articleContentTable)
            .set({
              language: newLanguage,
              title: newTitle,
              content: newContent,
              updated: sql`CURRENT_TIMESTAMP`,
              // When the body or language actually changes, clear the
              // previous summary state so a fresh attempt can run with
              // the new content/language, including unsticking any
              // earlier `summaryUnnecessary` mark and discarding any
              // summary that would now be in the wrong language.
              ...(contentChanged || languageChanged
                ? {
                    summary: null,
                    summaryStarted: null,
                    summaryUnnecessary: false,
                  }
                : {}),
            })
            .where(
              and(
                eq(articleContentTable.sourceId, id),
                eq(articleContentTable.language, originalContent.language),
              ),
            )
            .returning();
          if ((contentChanged || languageChanged) && updatedRows.length > 0) {
            resummarizeTarget = updatedRows[0];
          }
          if (contentChanged && updatedRows.length > 0) {
            originalContentChanged = true;
          }
          if (
            (contentChanged || titleChanged || languageChanged) &&
            updatedRows.length > 0
          ) {
            revisionTarget = updatedRows[0];
          }
        } catch (error) {
          if (
            error instanceof postgres.PostgresError &&
            error.code === "23503"
          ) {
            throw new LanguageChangeWithTranslationsError();
          }
          throw error;
        }
      }
      if (revisionTarget != null) {
        sourceRevision = await createSourceRevision(tx, id, revisionTarget);
        if (
          previousRevisionId != null &&
          previousRevisionId !== sourceRevision.id
        ) {
          await tx
            .update(articleSourceRevisionTable)
            .set({ publicUntil: getArticleReferenceTime(previous[0]) })
            .where(
              and(
                eq(articleSourceRevisionTable.id, previousRevisionId),
                isNull(articleSourceRevisionTable.publicUntil),
              ),
            );
        }
      }
      const contents = await tx.query.articleContentTable.findMany({
        where: { sourceId: id },
        orderBy: { published: "asc" },
      });
      if (sourceFields.content != null || sourceMedia != null) {
        const originalContent = contents.find(
          (content) =>
            content.originalLanguage == null &&
            content.translatorId == null &&
            content.translationRequesterId == null,
        );
        if (originalContent == null) {
          throw new Error("Missing original article content");
        }
        // Retain media referenced by live private translation drafts too: a
        // draft may rely on a source image the original body just dropped, and
        // pruning its mapping would break the draft's preview and its later
        // publication.
        const translationDrafts =
          await tx.query.articleTranslationDraftTable.findMany({
            where: { sourceId: id },
            columns: { content: true },
          });
        const mediaUpdated = await updateArticleSourceMedia(
          tx,
          id,
          originalContent.content,
          [
            ...contents.map((content) => content.content),
            ...translationDrafts.map((draft) => draft.content),
          ],
          sourceMedia,
        );
        if (!mediaUpdated) throw new InvalidArticleSourceMediumError();
      }
      return { ...sources[0], contents };
    });
  } catch (error) {
    if (error instanceof InvalidArticleSourceMediumError) return undefined;
    throw error;
  }
  if (result == null) return undefined;
  return {
    source: result,
    originalContentChanged,
    resummarizeTarget,
    sourceRevision,
  };
}

export interface UpdateArticleOptions {
  /**
   * The individual performing the edit, used to suppress a self-notification
   * when the editor is also the credited translator of an affected language.
   * The translation is still marked as needing review.
   *
   * It is the authenticated person, never the acting organization.
   */
  editor?: { accountId: Uuid } | null;
}

/**
 * Queues the in-app "original changed" push deliveries for after the
 * enclosing transaction commits, re-checking each recipient's access at
 * delivery time so a membership revoked in between stops the push.
 */
async function queueTranslationReviewPushes(
  fedCtx: ApplicationContext,
  pending: readonly PendingTranslationReviewPush[],
): Promise<void> {
  if (pending.length < 1) return;
  await queueAfterCommit(fedCtx, async () => {
    const db = fedCtx.rootDb ?? fedCtx.db;
    for (const push of pending) {
      try {
        if (!(await isTranslationReviewPushStillValid(db as Database, push))) {
          continue;
        }
        // Reuse the existing delivery machinery so the recipient's
        // preview-policy and locale settings apply unchanged; this issue adds
        // no new channel of its own.
        await sendNotificationPush(db as Database, {
          accountId: push.accountId,
          notificationId: push.notificationId,
          type: "article_translation_source_changed",
          actorId: push.actorId,
          postId: push.postId,
        });
      } catch (error) {
        logger.error(
          "Failed to deliver a translation review notification for " +
            "{accountId}: {error}",
          { accountId: push.accountId, error },
        );
      }
    }
  });
}

async function updateArticleOperation(
  fedCtx: ApplicationContext,
  articleSourceId: Uuid,
  source: Partial<NewArticleSource> & {
    title?: string;
    content?: string;
    language?: string;
    media?: readonly ArticleMediumInput[];
  },
  options: UpdateArticleOptions = {},
): Promise<
  | (Post & {
      actor: Actor & {
        account: Account & { emails: AccountEmail[]; links: AccountLink[] };
        instance: Instance;
      };
      articleSource: ArticleSource & {
        account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      };
    })
  | undefined
> {
  const { db } = fedCtx;
  const updateResult = await updateArticleSource(db, articleSourceId, source);
  if (updateResult == null) return undefined;
  const {
    source: articleSource,
    originalContentChanged,
    resummarizeTarget,
    sourceRevision,
  } = updateResult;
  // A new published revision, and only a new published revision, invalidates
  // the translations based on older ones and notifies the people credited with
  // them. Draft saves and metadata-only edits never reach this branch, and a
  // censored article still notifies locally even though nothing federates.
  if (sourceRevision != null) {
    const pending = await syncTranslationReviewNotifications(
      db,
      articleSourceId,
      {
        mode: "sourceChanged",
        suppressAccountId: options.editor?.accountId ?? null,
      },
    );
    await queueTranslationReviewPushes(fedCtx, pending);
  }
  if (resummarizeTarget != null) {
    await queueArticleContentSummary(fedCtx, resummarizeTarget);
  }
  const account = await db.query.accountTable.findFirst({
    where: { id: articleSource.accountId },
    with: { avatarMedium: true, emails: true, links: true },
  });
  if (account == null) return undefined;
  const post = await syncPostFromArticleSource(fedCtx, {
    ...articleSource,
    account,
  });
  // A censored article must not federate its (moderation-hidden) content: the
  // local edit persists, but no Update(Article) is delivered to followers or
  // tag relays (`publishArticleState` skips federation), and automatic
  // translations are not restarted while it remains censored.
  //
  // Automatic translations based on the old original are reset to
  // placeholders *before* the Update is built, in this same locked
  // transaction. Placeholders are never serialized, so the Update withdraws
  // those languages instead of republishing text translated from the old
  // original; each finished job re-adds its language with its own Update, and
  // a failed job has nothing to retract. The model calls themselves run after
  // commit.
  //
  // Gate on the article-level `allowLlmTranslation` switch so an edit that
  // turns LLM translation off in the same update does not still enqueue
  // background `translate()` runs against the author's just-expressed wish.
  // Existing translation rows from before the switch was flipped are left
  // alone (stale, not refreshed); re-enabling the switch and editing the body
  // again brings them back into sync.
  if (
    post.censored == null &&
    originalContentChanged &&
    articleSource.allowLlmTranslation
  ) {
    await restartArticleContentTranslations(fedCtx, articleSource);
  }
  // `updateArticleSource` already advanced the object version.
  await publishArticleState(fedCtx, articleSourceId, { bump: false });
  // TODO: send Update(Article) to the mentioned actors too
  const refreshed = await db.query.postTable.findFirst({
    where: { id: post.id },
    columns: { relayedTags: true },
  });
  if (refreshed != null) post.relayedTags = refreshed.relayedTags;
  return post;
}

export const updateArticle = transactional(updateArticleOperation);

/**
 * Re-points every translation draft (and every revision) owned by an original
 * draft to the article source created by publishing it.
 *
 * This runs inside the first-publication transaction before the original draft
 * is deleted, so unselected drafts survive under the published article and
 * keep their UUIDs, revisions, and media. Selected drafts additionally record
 * the revision that was published.
 */
export async function promoteArticleTranslationDrafts(
  db: Database | Transaction,
  originalDraftId: Uuid,
  sourceId: Uuid,
  selected: readonly { id: Uuid; revision: number }[],
): Promise<void> {
  // A translation may reference an image attached to the original draft but
  // absent from the original body and from every selected translation. Copy
  // those inherited references onto the surviving private translation before
  // the parent draft's media rows cascade away, otherwise the translation
  // loses the image the moment the original draft is deleted.
  const survivingDrafts = await db.query.articleTranslationDraftTable.findMany({
    where: { articleDraftId: originalDraftId },
  });
  if (survivingDrafts.length > 0) {
    const parentMedia = await db.query.articleDraftMediumTable.findMany({
      where: { articleDraftId: originalDraftId },
    });
    const parentByKey = new Map(parentMedia.map((m) => [m.key, m.mediumId]));
    for (const draft of survivingDrafts) {
      const referenced = extractArticleMediumKeys(draft.content);
      if (referenced.size === 0) continue;
      const existing =
        await db.query.articleTranslationDraftMediumTable.findMany({
          where: { articleTranslationDraftId: draft.id },
        });
      const existingKeys = new Set(existing.map((m) => m.key));
      const inherited = [...referenced]
        .filter((key) => !existingKeys.has(key) && parentByKey.has(key))
        .map((key) => ({
          articleTranslationDraftId: draft.id,
          key,
          mediumId: parentByKey.get(key)!,
        }));
      if (inherited.length > 0) {
        await db
          .insert(articleTranslationDraftMediumTable)
          .values(inherited)
          .onConflictDoNothing();
      }
    }
  }
  await db
    .update(articleTranslationDraftTable)
    .set({ sourceId, articleDraftId: null })
    .where(eq(articleTranslationDraftTable.articleDraftId, originalDraftId));
  if (selected.length > 0) {
    for (const { id, revision } of selected) {
      await db
        .update(articleTranslationDraftTable)
        .set({ publishedRevision: revision })
        .where(
          and(
            eq(articleTranslationDraftTable.id, id),
            eq(articleTranslationDraftTable.sourceId, sourceId),
          ),
        );
    }
  }
  await db
    .update(articleSourceRevisionTable)
    .set({ sourceId, articleDraftId: null })
    .where(eq(articleSourceRevisionTable.articleDraftId, originalDraftId));
}

export interface PublishArticleTranslationInput {
  translationDraftId: Uuid;
  revision: number;
  /**
   * The source revision the publisher was shown while reviewing, which becomes
   * the published version's baseline and records them as its reviewer.
   *
   * Omitting it publishes the baseline the draft already carried and records
   * no new reviewer evidence. That legacy path exists because an article that
   * has never been edited since revision tracking landed may have no snapshot
   * for the client to name.
   */
  sourceRevisionId?: Uuid | null;
}

export type PublishArticleTranslationResult =
  | {
      status: "ok";
      sourceId: Uuid;
      language: string;
      translationDraft: ArticleTranslationDraft;
    }
  | { status: "conflict"; currentRevision: number }
  | { status: "invalid"; inputPath: string }
  | { status: "forbidden" };

/**
 * Publishes one private translation draft into the article's public content.
 *
 * The draft revision is checked with optimistic concurrency. The public
 * content row's provenance is derived from the draft (`human` -> `human`,
 * `llm` -> `llm_reviewed`, `unknown` -> `unknown`), its reviewed baseline is
 * copied from the draft (never the current source revision), and any automatic
 * job that started earlier is fenced off because its row no longer satisfies
 * the in-progress/automatic/token predicates. The original post's title, body,
 * and summary are untouched: only the translated language version changes.
 */
export async function publishArticleTranslation(
  fedCtx: ApplicationContext,
  publisher: Account,
  input: PublishArticleTranslationInput,
): Promise<PublishArticleTranslationResult> {
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    return { status: "invalid", inputPath: "revision" };
  }
  type Outcome =
    | {
        kind: "ok";
        sourceId: Uuid;
        language: string;
        translationDraft: ArticleTranslationDraft;
      }
    | { kind: "conflict"; currentRevision: number }
    | { kind: "invalid"; inputPath: string }
    | { kind: "forbidden" };
  const outcome = await withTransaction<Outcome>(
    fedCtx,
    async (context): Promise<Outcome> => {
      // Owner first, then the translation draft. Every path that touches both
      // takes them in this order (`acknowledgeArticleTranslationSource`,
      // `saveArticleTranslationDraft`'s create path, `publishArticleDraft`),
      // and `updateArticleSource`/`restartArticleContentTranslations` go
      // source -> content without ever taking a translation-draft lock, so no
      // cycle is possible.
      const located =
        await context.db.query.articleTranslationDraftTable.findFirst({
          where: { id: input.translationDraftId },
          columns: { sourceId: true, translatorId: true },
        });
      if (located?.sourceId == null) {
        return { kind: "invalid", inputPath: "translationDraftId" };
      }
      // Account deletion locks the account row and then rewrites the
      // `article_content` rows crediting it. Writing `translatorId` below
      // takes a key-share lock on that same account for the foreign key, so
      // take it up front, before any content row: otherwise a deletion
      // waiting on our content row and our FK check waiting on its account
      // lock would deadlock.
      if (located.translatorId != null) {
        await context.db
          .select({ id: accountTable.id })
          .from(accountTable)
          .where(eq(accountTable.id, located.translatorId))
          .for("key share");
      }
      await lockArticleSource(context.db, located.sourceId);
      // Re-read the draft under the lock: the unlocked lookup above only
      // resolved which source to lock.
      const draftRows = await context.db
        .select()
        .from(articleTranslationDraftTable)
        .where(eq(articleTranslationDraftTable.id, input.translationDraftId))
        .for("update");
      const draft = draftRows[0];
      if (draft == null || draft.sourceId !== located.sourceId) {
        return { kind: "invalid", inputPath: "translationDraftId" };
      }
      const source = await context.db.query.articleSourceTable.findFirst({
        where: { id: draft.sourceId },
        with: { account: true, contents: true },
      });
      if (source == null) {
        return { kind: "invalid", inputPath: "translationDraftId" };
      }
      if (!(await canAccountActAs(context.db, publisher, source.accountId))) {
        return { kind: "forbidden" };
      }
      if (input.revision !== draft.revision) {
        return { kind: "conflict", currentRevision: draft.revision };
      }
      // A draft with no title or body is explicitly not ready to publish; an
      // empty version must never replace a published translation.
      if (draft.title.trim() === "" || draft.content.trim() === "") {
        return { kind: "invalid", inputPath: "translationDraftId" };
      }
      const original = source.contents.find(
        (content) => content.originalLanguage == null,
      );
      if (original == null || original.language === draft.language) {
        return { kind: "invalid", inputPath: "translationDraftId" };
      }
      // Both the publishing individual and the owning workspace must be
      // unsuspended: a suspended member keeps an authenticated session, but
      // must not publish through their organization.
      await assertAccountActorNotSuspended(context.db, publisher.id);
      await assertAccountActorNotSuspended(context.db, source.accountId);
      // The reviewed baseline: the revision the publisher was actually shown,
      // when the client identifies one, otherwise the baseline the draft has
      // carried since it was created. Only the former is evidence that a
      // person reviewed the current original, so only the former records a
      // reviewer.
      let baselineId = draft.sourceRevisionId;
      let reviewerId = draft.reviewerId;
      let reviewed: Date | null = draft.reviewed;
      if (input.sourceRevisionId != null) {
        const revision =
          await context.db.query.articleSourceRevisionTable.findFirst({
            where: { id: input.sourceRevisionId },
          });
        if (revision == null || revision.sourceId !== source.id) {
          return { kind: "invalid", inputPath: "sourceRevisionId" };
        }
        baselineId = revision.id;
        reviewerId = publisher.id;
        reviewed = new Date();
      }
      const provenance: ArticleContentProvenance =
        draft.provenance === "llm"
          ? "llm_reviewed"
          : draft.provenance === "unknown"
            ? "unknown"
            : "human";
      // Upsert atomically: a reader-triggered automatic translation can insert
      // a placeholder for this language between the read above and this write,
      // and a plain insert would fail on the primary key instead of replacing
      // and fencing off that job.
      await context.db
        .insert(articleContentTable)
        .values({
          sourceId: source.id,
          language: draft.language,
          title: draft.title,
          content: draft.content,
          originalLanguage: original.language,
          translatorId: draft.translatorId,
          provenance,
          sourceRevisionId: baselineId,
          reviewerId: baselineId == null ? null : reviewerId,
          reviewed: baselineId == null ? null : reviewed,
          beingTranslated: false,
        })
        .onConflictDoUpdate({
          target: [articleContentTable.sourceId, articleContentTable.language],
          set: {
            title: draft.title,
            content: draft.content,
            originalLanguage: original.language,
            translatorId: draft.translatorId,
            // The draft's credit replaces the previous version's, including a
            // retained credit for a since-deleted account.
            deletedTranslatorId: null,
            translationRequesterId: null,
            provenance,
            sourceRevisionId: baselineId,
            reviewerId: baselineId == null ? null : reviewerId,
            reviewed: baselineId == null ? null : reviewed,
            beingTranslated: false,
            translationJobToken: null,
            summary: null,
            summaryStarted: null,
            summaryUnnecessary: false,
            ogImageKey: null,
            updated: sql`CURRENT_TIMESTAMP`,
          },
        });
      // Promote the draft's media into the published source. Mappings are
      // immutable, so a key already mapped keeps its original medium.
      const draftMedia =
        await context.db.query.articleTranslationDraftMediumTable.findMany({
          where: { articleTranslationDraftId: draft.id },
        });
      const referenced = extractArticleMediumKeys(draft.content);
      const promote = draftMedia.filter((medium) => referenced.has(medium.key));
      if (promote.length > 0) {
        await context.db
          .insert(articleSourceMediumTable)
          .values(
            promote.map((medium) => ({
              articleSourceId: source.id,
              key: medium.key,
              mediumId: medium.mediumId,
            })),
          )
          .onConflictDoNothing();
      }
      const updatedDraft = await context.db
        .update(articleTranslationDraftTable)
        .set({
          publishedRevision: draft.revision,
          // Keep the private draft's baseline in step with what was just
          // published, so the translator does not have to acknowledge the same
          // revision twice.
          sourceRevisionId: baselineId,
          reviewerId: baselineId == null ? null : reviewerId,
          reviewed: baselineId == null ? null : reviewed,
        })
        .where(eq(articleTranslationDraftTable.id, draft.id))
        .returning();
      // Publishing against the current revision resolves the outstanding
      // review need for this language; drop it from (or delete) the
      // translator's notification without resurfacing it.
      await syncTranslationReviewNotifications(context.db, source.id, {
        mode: "reconcile",
      });
      // Advance the object version, rematerialize the reader variants, and
      // federate an Update built from this transaction's state while the
      // source lock is still held, so it cannot interleave with another
      // change. The original post's title/body/summary stay original-derived.
      await publishArticleState(context, source.id);
      // A censored article still gets a fresh summary for this language
      // locally; only the outgoing Update is withheld.
      const publishedContent =
        await context.db.query.articleContentTable.findFirst({
          where: { sourceId: source.id, language: draft.language },
        });
      if (publishedContent != null) {
        await queueArticleContentSummary(context, publishedContent);
      }
      return {
        kind: "ok",
        sourceId: source.id,
        language: draft.language,
        translationDraft: updatedDraft[0],
      };
    },
  );
  if (outcome.kind === "conflict") {
    return { status: "conflict", currentRevision: outcome.currentRevision };
  }
  if (outcome.kind === "invalid") {
    return { status: "invalid", inputPath: outcome.inputPath };
  }
  if (outcome.kind === "forbidden") {
    return { status: "forbidden" };
  }
  return {
    status: "ok",
    sourceId: outcome.sourceId,
    language: outcome.language,
    translationDraft: outcome.translationDraft,
  };
}

/**
 * Records a review acknowledgement ({@link acknowledgeArticleTranslationSource})
 * and, when it moved a published version's baseline, publishes the article's
 * new public state: the freshness notice and FEP-22cd `sourceUpdated` change
 * even though no translated text did, so peers need an `Update`.
 *
 * Acknowledging only a private draft, or re-acknowledging the revision the
 * published version already carries, federates nothing.
 */
export async function acknowledgeArticleTranslation(
  fedCtx: ApplicationContext,
  viewer: Pick<Account, "id" | "kind">,
  input: AcknowledgeArticleTranslationSourceInput,
): Promise<AcknowledgeArticleTranslationSourceResult> {
  return await withTransaction(fedCtx, async (context) => {
    if ("sourceId" in input.owner) {
      // Moving a published baseline publishes an Update of the whole
      // article, so the same suspension rules as publication apply: a
      // suspended member keeps an authenticated session.
      const source = await context.db.query.articleSourceTable.findFirst({
        where: { id: input.owner.sourceId },
        columns: { accountId: true },
      });
      if (source != null) {
        await assertAccountActorNotSuspended(context.db, viewer.id);
        await assertAccountActorNotSuspended(context.db, source.accountId);
      }
    }
    const result = await acknowledgeArticleTranslationSource(
      context.db,
      viewer,
      input,
    );
    if (
      result.status === "ok" &&
      result.publishedBaselineChanged &&
      "sourceId" in input.owner
    ) {
      // The acknowledgement above still holds the source lock.
      await publishArticleState(context, input.owner.sourceId);
    }
    return result;
  });
}

export interface WithdrawArticleTranslationInput {
  sourceId: Uuid;
  language: string;
}

export type WithdrawArticleTranslationResult =
  | {
      status: "ok";
      sourceId: Uuid;
      language: string;
      /** The private draft kept for the language, now unpublished. */
      translationDraft: ArticleTranslationDraft | undefined;
    }
  | { status: "invalid"; inputPath: string }
  | { status: "forbidden" };

/**
 * Withdraws a published, human-managed translation from an article.
 *
 * The language disappears from the public article and from the next federated
 * `Update`, which omits both its `contentMap` entry and its FEP-22cd
 * `Translation` entry: the proposal's removal semantics, never a `Delete`,
 * which would remove the whole article. The article keeps its identity,
 * replies and reactions.
 *
 * The language's private translation draft, if any, is kept and becomes
 * unpublished, so the work can be published again later.
 *
 * Automatic translations cannot be withdrawn this way: they are governed by
 * the article's `allowLlmTranslation` setting. Conversely, withdrawing a human
 * translation does not suppress automatic ones: while that setting stays
 * enabled, a reader can request an automatic translation of the language
 * again, exactly as for a language that was never translated.
 */
export async function withdrawArticleTranslation(
  fedCtx: ApplicationContext,
  viewer: Pick<Account, "id" | "kind">,
  input: WithdrawArticleTranslationInput,
): Promise<WithdrawArticleTranslationResult> {
  const language = normalizeContentLanguage(input.language);
  if (language == null) return { status: "invalid", inputPath: "language" };
  return await withTransaction(
    fedCtx,
    async (context): Promise<WithdrawArticleTranslationResult> => {
      if (!(await lockArticleSource(context.db, input.sourceId))) {
        return { status: "invalid", inputPath: "sourceId" };
      }
      const source = await context.db.query.articleSourceTable.findFirst({
        where: { id: input.sourceId },
        columns: { id: true, accountId: true },
      });
      if (source == null) return { status: "invalid", inputPath: "sourceId" };
      if (!(await canAccountActAs(context.db, viewer, source.accountId))) {
        return { status: "forbidden" };
      }
      await assertAccountActorNotSuspended(context.db, viewer.id);
      await assertAccountActorNotSuspended(context.db, source.accountId);
      const content = await context.db.query.articleContentTable.findFirst({
        where: { sourceId: source.id, language },
        columns: { originalLanguage: true, provenance: true },
      });
      if (
        content == null ||
        content.originalLanguage == null ||
        content.provenance === "llm"
      ) {
        return { status: "invalid", inputPath: "language" };
      }
      await context.db
        .delete(articleContentTable)
        .where(
          and(
            eq(articleContentTable.sourceId, source.id),
            eq(articleContentTable.language, language),
          ),
        );
      const drafts = await context.db
        .update(articleTranslationDraftTable)
        .set({ publishedRevision: null })
        .where(
          and(
            eq(articleTranslationDraftTable.sourceId, source.id),
            eq(articleTranslationDraftTable.language, language),
          ),
        )
        .returning();
      // The withdrawn version no longer needs review, so it drops out of (or
      // deletes) its translator's outstanding notification; a private draft
      // that is still behind keeps it.
      await syncTranslationReviewNotifications(context.db, source.id, {
        mode: "reconcile",
      });
      await publishArticleState(context, source.id);
      return {
        status: "ok",
        sourceId: source.id,
        language,
        translationDraft: drafts[0],
      };
    },
  );
}

export async function startArticleContentSummary(
  db: Database,
  model: ApplicationModel,
  content: ArticleContent,
  summarize: AiServices["summarize"],
): Promise<void> {
  // Use a JS-side Date so the value round-trips through the driver
  // with millisecond precision.  This is later used as a CAS stamp.
  const claim = new Date();
  const updated = await db
    .update(articleContentTable)
    .set({ summaryStarted: claim })
    .where(
      and(
        eq(articleContentTable.sourceId, content.sourceId),
        eq(articleContentTable.language, content.language),
        eq(articleContentTable.summaryUnnecessary, false),
        // Don't summarize translation placeholders whose content has
        // not yet been replaced by the translated text.
        eq(articleContentTable.beingTranslated, false),
        or(
          isNull(articleContentTable.summaryStarted),
          lt(
            articleContentTable.summaryStarted,
            sql`CURRENT_TIMESTAMP - INTERVAL '30 minutes'`,
          ),
        ),
      ),
    )
    .returning();
  if (updated.length < 1) {
    logger.debug("Summary already started or not needed.");
    return;
  }
  // Use the row state captured at claim time (with the latest body and
  // metadata) instead of the caller's potentially stale `content`
  // argument.  This guards against a concurrent edit that committed
  // between the caller's fetch and our claim.
  const claimed = updated[0];
  logger.debug("Starting summary for content: {sourceId} {language}", claimed);
  void summarize({
    model,
    sourceLanguage: claimed.beingTranslated
      ? (claimed.originalLanguage ?? claimed.language)
      : claimed.language,
    targetLanguage: claimed.language,
    text: claimed.content,
  })
    .then(async (summary) => {
      await applyArticleContentSummary(db, claimed, summary, claim);
    })
    .catch(async (error) => {
      logger.error("Summary failed ({sourceId} {language}): {error}", {
        ...claimed,
        error,
      });
      try {
        await db
          .update(articleContentTable)
          .set({ summaryStarted: null })
          .where(
            and(
              eq(articleContentTable.sourceId, claimed.sourceId),
              eq(articleContentTable.language, claimed.language),
              eq(articleContentTable.summaryStarted, claim),
            ),
          );
      } catch (resetError) {
        // The summary runs in the background, so its failure handler must
        // not create another unhandled rejection when the database is
        // unavailable or has already closed during shutdown.
        logger.error(
          "Failed to reset summary claim ({sourceId} {language}): {error}",
          {
            ...claimed,
            error: resetError,
          },
        );
      }
    });
}

/**
 * Persists the result of summarizing an article content row.
 *
 * If the generated `summary` is not strictly shorter than the row's
 * current content (re-fetched to avoid acting on stale data after a
 * concurrent edit), the summary is discarded and the row is marked as
 * `summaryUnnecessary` so that subsequent calls to
 * {@link startArticleContentSummary} skip it.  Otherwise, the summary is
 * saved on both the `article_content` row and the corresponding `post`
 * row (when the content is in the article's original language).
 *
 * When `claim` is given, the function only writes if `summaryStarted`
 * still matches the claim — that is, no newer summarization has
 * re-acquired the lock in the meantime.  This prevents an older
 * summarization that exceeded the 30-minute timeout from clobbering a
 * newer attempt's state.
 *
 * If the row no longer exists, this is a no-op.
 */
export async function applyArticleContentSummary(
  db: Database,
  content: ArticleContent,
  summary: string,
  claim?: Date,
): Promise<void> {
  // Wrap the article_content and the mirrored post update in a single
  // transaction so they are observed atomically, and so a concurrent
  // edit cannot land between the two writes and let the older
  // summarization clobber `post.summary` after the CAS-guarded
  // `article_content` update.
  await db.transaction(async (tx) => {
    // Take the source lock before the content row, the order every other
    // writer uses, so the variant mirrored below cannot be overwritten by a
    // concurrent rematerialization built from an older read.
    await lockArticleSource(tx, content.sourceId);
    // Re-fetch the row so that we don't act on stale state after a
    // concurrent edit happened between the LLM call and now.
    const current = await tx.query.articleContentTable.findFirst({
      where: {
        sourceId: content.sourceId,
        language: content.language,
      },
    });
    if (current == null) return;
    if (current.content !== content.content) {
      // The body changed while the summarizer was running, so the
      // summary we just produced is for an outdated text.  Drop the
      // result and do not touch `summaryStarted`, which
      // `updateArticleSource()` already cleared (and a newer
      // summarization may have re-claimed in the meantime).
      logger.debug(
        "Article content changed during summarization; dropping stale " +
          "summary ({sourceId} {language}).",
        content,
      );
      return;
    }
    // Build a CAS-style condition that only matches if the
    // summarization claim is still ours.
    const claimWhere =
      claim == null ? undefined : eq(articleContentTable.summaryStarted, claim);
    const trimmedSummary = summary.trim();
    const summaryComparisonContent = removeDetailsFromSummaryInput(
      current.content,
    ).trim();
    if (
      trimmedSummary.length === 0 ||
      graphemeCount(trimmedSummary) >= graphemeCount(summaryComparisonContent)
    ) {
      logger.debug(
        "Summary is not shorter than the original content (or is empty); " +
          "discarding ({sourceId} {language}).",
        content,
      );
      const updated = await tx
        .update(articleContentTable)
        .set({
          summary: null,
          summaryUnnecessary: true,
          summaryStarted: null,
          updated: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(articleContentTable.sourceId, content.sourceId),
            eq(articleContentTable.language, content.language),
            claimWhere,
          ),
        )
        .returning({ sourceId: articleContentTable.sourceId });
      if (updated.length < 1) {
        // Lost the race to a newer claim; leave it alone.
        return;
      }
      await syncArticleContentVariantSummary(
        tx,
        content.sourceId,
        content.language,
        null,
      );
      if (content.originalLanguage == null) {
        await tx
          .update(postTable)
          .set({ summary: null })
          .where(
            and(
              eq(postTable.articleSourceId, content.sourceId),
              eq(postTable.language, content.language),
            ),
          );
      }
      return;
    }
    const updated = await tx
      .update(articleContentTable)
      .set({
        summary,
        // Release the summarization claim now that we've persisted the
        // result, and bump `updated` so observers see the row's new
        // state.
        summaryStarted: null,
        updated: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(articleContentTable.sourceId, content.sourceId),
          eq(articleContentTable.language, content.language),
          claimWhere,
        ),
      )
      .returning({ sourceId: articleContentTable.sourceId });
    if (updated.length < 1) {
      // Lost the race to a newer claim; leave the saved state to that
      // newer summarization.
      return;
    }
    await syncArticleContentVariantSummary(
      tx,
      content.sourceId,
      content.language,
      summary,
    );
    if (content.originalLanguage == null) {
      await tx
        .update(postTable)
        .set({ summary })
        .where(
          and(
            eq(postTable.articleSourceId, content.sourceId),
            eq(postTable.language, content.language),
          ),
        );
    }
  });
}

export interface ArticleContentTranslationOptions {
  content: ArticleContent;
  targetLanguage: string;
  requester: Account;
}

export async function startArticleContentTranslation(
  fedCtx: ApplicationContext,
  { content, targetLanguage, requester }: ArticleContentTranslationOptions,
): Promise<ArticleContent> {
  const { db } = fedCtx;
  // Stamp `updated` with a JS-side Date rather than letting it
  // default to PG's `CURRENT_TIMESTAMP`.  See the long comment on
  // the CAS in `runArticleContentTranslation` for why this matters:
  // the helper's claim WHERE compares the row's stored `updated`
  // against `queued.updated`, and the comparison is only reliable
  // when both sides round-trip through the same precision (the
  // `postgres` driver hands JS `Date` values back at ms precision
  // while `timestamptz` keeps µs).
  const queueStamp = new Date();
  const queueToken = generateUuidV7();
  const inserted = await db
    .insert(articleContentTable)
    .values({
      sourceId: content.sourceId,
      language: targetLanguage,
      title: content.title,
      content: content.content,
      originalLanguage: content.language,
      translationRequesterId: requester.id,
      provenance: "llm",
      // Stamp the baseline in the same statement that writes the text, and
      // only when the current snapshot is exactly that text. There is no
      // source lock on this path, so a concurrent edit must degrade to an
      // unknown baseline rather than let the job claim freshness against a
      // revision it never translated.
      sourceRevisionId: matchingSourceRevisionSql(content.sourceId, {
        language: content.language,
        title: content.title,
        content: content.content,
      }),
      translationJobToken: queueToken,
      beingTranslated: true,
      updated: queueStamp,
    })
    .onConflictDoNothing()
    .returning();
  let queued: ArticleContent;
  if (inserted.length < 1) {
    const translated = await db.query.articleContentTable.findFirst({
      where: {
        sourceId: content.sourceId,
        language: targetLanguage,
      },
    });
    if (
      !translated?.beingTranslated ||
      (translated?.updated?.getTime() ?? 0) > Date.now() - 30 * 60 * 1000
    ) {
      // If the translation is already started and not older than 30 minutes
      logger.debug("Translation already started or not needed.");
      return translated!;
    }
    // The placeholder is stale (older than 30 min, presumably from
    // a crashed previous run).  Refresh it before handing off to
    // the helper:
    //
    // - Re-stamp `updated` with a fresh JS Date so the helper's
    //   claim CAS has a value it can match (without this, the CAS
    //   would be comparing against the row's possibly-µs-precision
    //   DB timestamp via a ms-truncated round-trip and never hit).
    // - Copy the caller-provided original title/content into the
    //   placeholder.  The helper translates from `claimed.title` /
    //   `claimed.content`, so without this refresh a placeholder
    //   stuck since before a body edit would be retranslated from
    //   the OLD body and publish a translation that no longer
    //   matches the article.  Clear the matching summary / OG
    //   image state for the same reason.
    const reclaim = new Date();
    const reclaimed = await db
      .update(articleContentTable)
      .set({
        updated: reclaim,
        title: content.title,
        content: content.content,
        originalLanguage: content.language,
        provenance: "llm",
        sourceRevisionId: matchingSourceRevisionSql(content.sourceId, {
          language: content.language,
          title: content.title,
          content: content.content,
        }),
        reviewerId: null,
        reviewed: null,
        translationJobToken: queueToken,
        summary: null,
        summaryStarted: null,
        summaryUnnecessary: false,
        ogImageKey: null,
      })
      .where(
        and(
          eq(articleContentTable.sourceId, content.sourceId),
          eq(articleContentTable.language, targetLanguage),
          eq(articleContentTable.beingTranslated, true),
          // Never reclaim a human-managed or unknown row: only an automatic
          // row that a previous automatic job left in progress is refreshable.
          eq(articleContentTable.provenance, "llm"),
          // Repeat the staleness check inside the UPDATE itself so
          // the reclaim is CAS-safe.  If a concurrent worker just
          // reclaimed the same stale placeholder between our SELECT
          // above and this UPDATE, their reclaim wrote a fresh
          // `updated` past the threshold and PG's UPDATE re-evals
          // this WHERE on the new row state, which makes our
          // UPDATE drop the row from the candidate set and return
          // 0 rows.  That keeps us from stomping on the other
          // worker's claim and double-firing `translate()`.
          lt(
            articleContentTable.updated,
            sql`CURRENT_TIMESTAMP - INTERVAL '30 minutes'`,
          ),
        ),
      )
      .returning();
    if (reclaimed.length < 1) {
      // Lost the race to another writer that just reclaimed this
      // row, or completed it, between our SELECT and our UPDATE.
      // Return the row we observed; nothing further to do.
      return translated;
    }
    queued = reclaimed[0];
  } else {
    queued = inserted[0];
  }
  await runArticleContentTranslation(fedCtx, queued);
  return queued;
}

/**
 * Invalidates and re-runs every existing translation row for an
 * article whose original-language body has changed.  For each
 * translation row, atomically resets it to placeholder state
 * (copying the new original title/content into it, flipping
 * `beingTranslated` back to true, and clearing summary state), then
 * fires {@link runArticleContentTranslation} against the freshly
 * reset row to repopulate it from the model.  The actual translation
 * runs in the background; the synchronous claim-and-reset is
 * awaited so callers can rely on placeholders being in place by
 * return time.
 *
 * Returns the rows the reset produced, before any background translation has
 * touched them.
 *
 * No-ops when the article has no original-language content (e.g.,
 * remote articles with no `articleSource.contents` row in the
 * article's own language) or no translation rows at all.
 *
 * Used by {@link updateArticle} to satisfy
 * <https://github.com/hackers-pub/hackerspub/issues/95>.
 */
export async function restartArticleContentTranslations(
  fedCtx: ApplicationContext,
  articleSource: ArticleSource,
): Promise<ArticleContent[]> {
  const { db } = fedCtx;
  // Serialize the read-original-then-reset-translations sequence
  // against any other writer to this article's source row.  Two
  // concurrent restartArticleContentTranslations calls (driven by
  // back-to-back edits to the same article) would otherwise read
  // their own snapshot of the original and then overwrite each
  // other's placeholder writes, leaving the translation rows
  // pointing at whichever snapshot's UPDATE happened to land last.
  // `SELECT … FOR UPDATE` on the article_source row holds the same
  // row-level write lock that updateArticleSource takes during its
  // own UPDATE, so concurrent edits and restarts queue up cleanly.
  // The translate() calls themselves run after the transaction
  // commits so the LLM round-trip doesn't extend the lock window.
  const resetRows = await db.transaction(async (tx) => {
    await tx
      .select({ id: articleSourceTable.id })
      .from(articleSourceTable)
      .where(eq(articleSourceTable.id, articleSource.id))
      .for("update");
    const original = await getOriginalArticleContent(tx, articleSource);
    if (original == null) {
      logger.debug(
        "No original-language content for {sourceId}; nothing to retranslate.",
        { sourceId: articleSource.id },
      );
      return [];
    }
    // Reset every translation row to placeholder state in a single
    // statement, mirroring the shape an initial
    // `startArticleContentTranslation` would have produced.  The
    // `originalLanguage IS NOT NULL` filter targets exactly the
    // translation rows for this article (the same set the previous
    // implementation listed via `findMany` and then iterated over);
    // the schema check `article_content_being_translated_check`
    // requires `originalLanguage IS NOT NULL` whenever
    // `beingTranslated=true`, which the filter already satisfies.
    // `originalLanguage` and `translationRequesterId` are not in
    // `set`, so each row's audit trail (who first asked for this
    // translation) is preserved.
    // Stamp `updated` with a JS-side Date rather than PG
    // `CURRENT_TIMESTAMP` so it round-trips losslessly through the
    // driver and the per-row claim CAS in
    // `runArticleContentTranslation` can match it; see the long
    // comment on that claim for the µs/ms precision rationale.
    const restartStamp = new Date();
    const restartRevision = await ensureSourceRevision(tx, articleSource.id);
    const restartRevisionId = restartRevision?.id ?? null;
    const reset = await tx
      .update(articleContentTable)
      .set({
        title: original.title,
        content: original.content,
        beingTranslated: true,
        // Re-stamp the baseline to the snapshot this restart translates from,
        // overwriting whatever the previous run recorded. The enclosing
        // transaction holds the source lock and copies the original verbatim,
        // so the match always succeeds unless the article has no snapshot at
        // all, in which case the row honestly reports an unknown baseline.
        sourceRevisionId: restartRevisionId,
        reviewerId: null,
        reviewed: null,
        // Rotate the job token so a worker still running against the previous
        // revision cannot write its result back.
        translationJobToken: generateUuidV7(),
        summary: null,
        summaryStarted: null,
        summaryUnnecessary: false,
        // Clear the cached OG image too: it was rendered from the
        // previous title/body and is now stale.  Lazy regeneration
        // on the next OG-image request will rebuild it from the
        // freshly translated content.
        ogImageKey: null,
        updated: restartStamp,
      })
      .where(
        and(
          eq(articleContentTable.sourceId, articleSource.id),
          isNotNull(articleContentTable.originalLanguage),
          // Only automatic translations.  Human and legacy-unknown rows are
          // never reset to a source-language placeholder so the LLM can redo
          // them; doing so would silently destroy a contributor's work and
          // mis-attribute the result.
          eq(articleContentTable.provenance, "llm"),
          isNull(articleContentTable.translatorId),
        ),
      )
      .returning();
    if (reset.length > 0) {
      logger.debug("Restarted {count} translation(s) for {sourceId}.", {
        count: reset.length,
        sourceId: articleSource.id,
      });
    }
    return reset;
  });
  for (const resetRow of resetRows) {
    // Fire-and-forget: `runArticleContentTranslation` schedules the
    // `translate()` chain on its own and the caller does not await
    // the model call.  Each translation runs concurrently.
    // The `.catch()` is here because the synchronous setup before
    // the chain is installed (the claim UPDATE, the article-source
    // fetch) can itself throw on a transient DB error; without it
    // those rejections would surface as unhandled promise
    // rejections.
    await queueAfterCommit(fedCtx, () => {
      const rootDb = fedCtx.rootDb ?? fedCtx.db;
      const backgroundContext: ApplicationContext = {
        ...fedCtx.withDatabase(rootDb),
        db: rootDb,
        rootDb,
        afterCommit: undefined,
      };
      return runArticleContentTranslation(backgroundContext, resetRow).catch(
        (error) => {
          logger.error(
            "Failed to start retranslation for {sourceId} {language}: {error}",
            {
              sourceId: resetRow.sourceId,
              language: resetRow.language,
              error,
            },
          );
        },
      );
    });
  }
  // Returned so callers (and tests) can inspect the placeholders the reset
  // produced without racing the background translation, which rewrites or
  // clears these rows as soon as the model answers or fails.
  return resetRows;
}

/**
 * Splits an LLM translation output into its title and body halves.
 *
 * The translator is prompted with `# {title}\n\n{body}` and is
 * expected to return the same shape with both halves translated.
 * In practice models usually do.  When they don't (e.g., they drop
 * the H1 framing entirely), the strict behavior here is:
 *
 * - The first line is taken as the title.  If it begins with `# `,
 *   the marker is stripped; otherwise the whole line becomes the
 *   title verbatim.
 * - Everything after the first line becomes the body.
 *
 * Scanning deeper for an H1 elsewhere in the output is *not* done
 * on purpose: it would handle a "model put a preamble before the
 * # Title" case nicely but at the cost of silently truncating
 * content if the model omits the article-title H1 and the body
 * happens to contain its own H1 section heading; that body H1
 * would be mis-promoted to the title and the intro paragraphs
 * would be dropped.  Leaving a preamble visible as the title is
 * the lesser of those two failures.  The H1-marker detection on
 * the first line is restricted to a single `#` followed by
 * whitespace, so a first-line `## Section` is not mis-stripped.
 */
export function splitTranslationTitleAndContent(translation: string): {
  title: string;
  content: string;
} {
  const trimmed = translation.trim();
  if (trimmed === "") return { title: "", content: "" };
  // `trimmed` is guaranteed non-empty and starts with a non-
  // whitespace character, so `lines[0]` is the first non-empty
  // line as text and there's no need to scan past it.
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0].trim();
  const h1AtStart = firstLine.match(/^#\s+(.+)$/);
  return {
    title: (h1AtStart?.[1] ?? firstLine).trim(),
    content: lines.slice(1).join("\n").trim(),
  };
}

/**
 * Runs the actual LLM translation for an `article_content` row that is
 * already in the placeholder / `beingTranslated` state.  Awaits the
 * synchronous setup (fetching author/tag context for the model), then
 * schedules the `translate(...)` chain and returns; the caller does
 * not await the translation itself.  When the model resolves, the
 * row is overwritten with the translated title/body, a federation
 * `Update` activity is sent, and post-translation summarization is
 * kicked off.  On failure, the placeholder row is deleted so a future
 * visit can re-queue.
 *
 * Should never be called with an original-language row
 * (`originalLanguage IS NULL`); the caller is responsible for placing
 * the row into the placeholder state first.
 */
async function runArticleContentTranslation(
  fedCtx: ApplicationContext,
  queued: ArticleContent,
): Promise<void> {
  const {
    db,
    models: { translator: model, summarizer },
  } = fedCtx;
  logger.debug(
    "Starting translation for content: {sourceId} {language}",
    queued,
  );
  const { sourceId, language: targetLanguage, originalLanguage } = queued;
  if (originalLanguage == null) {
    // Defensive: a row without `originalLanguage` is the original-
    // language content itself and should never be passed in here.
    logger.error(
      "runArticleContentTranslation called for an original-language row; " +
        "skipping ({sourceId} {language}).",
      queued,
    );
    return;
  }

  // Take ownership of the placeholder row by stamping it with a
  // JS-side `Date` that becomes our claim id, and read the row's
  // freshest title/content back via `RETURNING`.  Subsequent
  // success / failure writes from this run only land if the row's
  // `updated` still equals this claim — a concurrent re-translation
  // that resets the row out from under us bumps `updated` past this
  // value, and our writes turn into no-ops instead of clobbering
  // the fresher claim.  Using a JS `Date` (rather than PG
  // `CURRENT_TIMESTAMP`) is what makes this CAS reliable: PG
  // `timestamptz` keeps µs precision while the `postgres` driver
  // hands back JS `Date` values truncated to ms, so a CAS against
  // the round-tripped value of a `CURRENT_TIMESTAMP` write would
  // never match.
  //
  // Three further guards live here:
  // - `beingTranslated=true` on the WHERE bails out silently if the
  //   row has already been completed (or deleted) by another writer
  //   between the caller queueing this run and the claim landing.
  // - `updated = queued.updated` makes the claim itself
  //   conditional on the row not having been re-stamped under us
  //   by a concurrent `restartArticleContentTranslations` (or a
  //   parallel run for the same row).  Without this, two runs
  //   triggered by back-to-back edits both pass the
  //   `beingTranslated` check and both end up calling `translate()`,
  //   wasting an LLM round trip even though the success/failure
  //   CAS below would still ensure only one write lands.  All
  //   writers that produce a `queued` for this helper
  //   (`startArticleContentTranslation`'s INSERT, its stuck-row
  //   re-stamp branch, and `restartArticleContentTranslations`'s
  //   reset UPDATE) explicitly stamp `updated` with a JS `Date`
  //   for the same round-trip-precision reason as the claim above;
  //   the comparison is lossless.
  // - The translate input below is built from `claimed.title` /
  //   `claimed.content` rather than the caller's `queued` snapshot.
  //   When two `restartArticleContentTranslations` calls race, the
  //   later one writes the freshest body into the placeholder; this
  //   helper then translates *that* body instead of the stale body
  //   from whichever caller it was queued for.
  const claim = new Date();
  const claimedRows = await db
    .update(articleContentTable)
    .set({ updated: claim })
    .where(
      and(
        eq(articleContentTable.sourceId, sourceId),
        eq(articleContentTable.language, targetLanguage),
        eq(articleContentTable.beingTranslated, true),
        eq(articleContentTable.provenance, "llm"),
        queued.translationJobToken == null
          ? isNull(articleContentTable.translationJobToken)
          : eq(
              articleContentTable.translationJobToken,
              queued.translationJobToken,
            ),
        eq(articleContentTable.updated, queued.updated),
      ),
    )
    .returning();
  if (claimedRows.length < 1) {
    logger.debug(
      "Translation claim failed; row is not (or no longer) a " +
        "placeholder ({sourceId} {language}).",
      queued,
    );
    return;
  }
  const claimed = claimedRows[0];

  // Fetch article source with author information for translation context.
  const articleSource = await db.query.articleSourceTable.findFirst({
    where: { id: sourceId },
    with: {
      account: {
        with: {
          actor: true,
        },
      },
    },
  });

  // Combine title and content for translation, using the freshest
  // values read back from the claim above.
  const text = `# ${claimed.title}\n\n${claimed.content}`;
  // `claimed.originalLanguage` is non-null in practice: the claim
  // WHERE required `beingTranslated=true`, and the schema check
  // `article_content_being_translated_check` makes that imply
  // `originalLanguage IS NOT NULL`.  Drizzle types it as nullable
  // because the column is nullable in general, so assert.
  fedCtx.services.ai
    .translate({
      model,
      summarizationModel: summarizer,
      sourceLanguage: claimed.originalLanguage!,
      targetLanguage,
      text,
      // Pass context for better translation quality.
      authorName: articleSource?.account?.actor?.name ?? undefined,
      authorBio: articleSource?.account?.actor?.bioHtml ?? undefined,
      tags: articleSource?.tags,
    })
    .then(
      async (translation) => {
        try {
          logger.debug("Translation completed: {sourceId} {language}", {
            ...queued,
            translation,
          });
          const { title, content } =
            splitTranslationTitleAndContent(translation);
          const rootDb = fedCtx.rootDb ?? db;
          const backgroundContext: ApplicationContext = {
            ...fedCtx.withDatabase(rootDb),
            db: rootDb,
            rootDb,
            afterCommit: undefined,
          };
          await withTransaction(backgroundContext, async (txFedCtx) => {
            const tx = txFedCtx.db;
            // Source lock first, like every other writer of this article's
            // content (edits, publications, acknowledgements), so this
            // completion is ordered against them and cannot deadlock by
            // taking the locks in the reverse order.
            if (!(await lockArticleSource(tx, sourceId))) return;
            const updated = await tx
              .update(articleContentTable)
              .set({
                title,
                content,
                beingTranslated: false,
                translationJobToken: null,
                updated: sql`CURRENT_TIMESTAMP`,
                // The translation has just replaced the placeholder content,
                // so any existing summary state from the original-language
                // body no longer applies.  Clear it so a fresh summary can be
                // generated for the translated text below.
                summary: null,
                summaryStarted: null,
                summaryUnnecessary: false,
                // The cached OG image was rendered from the placeholder
                // (or from a prior translation of an older body) and is
                // now stale; clear it for the same reason as `summary` so
                // the next request regenerates it from the translated text.
                ogImageKey: null,
              })
              .where(
                and(
                  eq(articleContentTable.sourceId, sourceId),
                  eq(articleContentTable.language, targetLanguage),
                  eq(articleContentTable.provenance, "llm"),
                  queued.translationJobToken == null
                    ? isNull(articleContentTable.translationJobToken)
                    : eq(
                        articleContentTable.translationJobToken,
                        queued.translationJobToken,
                      ),
                  // CAS on the claim taken at the top of this function — see
                  // that comment for why a JS `Date` rather than the row's
                  // round-tripped `updated` is the safe reference.  If a
                  // concurrent re-translation took its own claim under us
                  // the `updated` will no longer match `claim` and this
                  // write becomes a no-op so we don't clobber its fresher
                  // placeholder with our stale text.
                  eq(articleContentTable.updated, claim),
                ),
              )
              .returning();
            if (updated.length < 1) {
              logger.debug(
                "Stale translation claim, skipping federation/summary " +
                  "({sourceId} {language}).",
                queued,
              );
              return;
            }
            // Advances the object version (so receivers accept the Update),
            // rematerializes the reader variants, and federates unless the
            // article is censored. The job-token CAS above already fenced off
            // any older or superseded job, so a delayed result can never
            // restore superseded text or replace a human-published version.
            await publishArticleState(txFedCtx, sourceId);
            // TODO: send Update(Article) to the mentioned actors too
            await queueAfterCommit(txFedCtx, () =>
              startArticleContentSummary(
                rootDb,
                summarizer,
                updated[0],
                txFedCtx.services.ai.summarize,
              ),
            );
          });
        } catch (error) {
          logger.error(
            "Failed to persist completed translation " +
              "({sourceId} {language}): {error}",
            {
              ...queued,
              error,
            },
          );
          try {
            await (fedCtx.rootDb ?? db)
              .update(articleContentTable)
              // Keep the placeholder but make its claim older than the
              // 30-minute staleness threshold so the next request can retry
              // immediately.  The CAS below must still match this run's claim.
              .set({ updated: new Date(0) })
              .where(
                and(
                  eq(articleContentTable.sourceId, sourceId),
                  eq(articleContentTable.language, targetLanguage),
                  eq(articleContentTable.beingTranslated, true),
                  eq(articleContentTable.provenance, "llm"),
                  queued.translationJobToken == null
                    ? isNull(articleContentTable.translationJobToken)
                    : eq(
                        articleContentTable.translationJobToken,
                        queued.translationJobToken,
                      ),
                  eq(articleContentTable.updated, claim),
                ),
              );
          } catch (resetError) {
            logger.error(
              "Failed to reset translation claim " +
                "({sourceId} {language}): {error}",
              {
                ...queued,
                error: resetError,
              },
            );
          }
        }
      },
      async (error) => {
        logger.error("Translation failed ({sourceId} {language}): {error}", {
          ...queued,
          error,
        });
        await db.delete(articleContentTable).where(
          and(
            eq(articleContentTable.sourceId, sourceId),
            eq(articleContentTable.language, targetLanguage),
            eq(articleContentTable.provenance, "llm"),
            queued.translationJobToken == null
              ? isNull(articleContentTable.translationJobToken)
              : eq(
                  articleContentTable.translationJobToken,
                  queued.translationJobToken,
                ),
            // CAS on the same claim as the success path — a stale
            // failure must not delete a row another caller has since
            // re-claimed.
            eq(articleContentTable.updated, claim),
          ),
        );
      },
    );
}
