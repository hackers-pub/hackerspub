import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getCurrentDraftRevision,
  getCurrentSourceRevision,
} from "./article-revision.ts";
import type { Database, Transaction } from "./db.ts";
import { runInTransaction } from "./db.ts";
import { normalizeContentLanguage } from "./i18n.ts";
import {
  canAccountActAs,
  lockOrganizationMembershipSet,
} from "./organization.ts";
import {
  type Account,
  type ArticleContent,
  type ArticleSourceRevision,
  type ArticleTranslationDraft,
  articleContentTable,
  articleDraftTable,
  articleSourceTable,
  articleTranslationDraftTable,
  notificationTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

/**
 * Whether a language version has been reviewed against the original it is
 * published alongside.
 *
 * `unknownBaseline` is deliberately distinct from `needsReview`: it means no
 * baseline was ever recorded (a version that predates revision tracking, or an
 * automatic job whose input could not be matched to a snapshot), so the
 * platform cannot claim that a particular source edit happened after it.
 */
export type TranslationReviewState =
  | "current"
  | "needsReview"
  | "unknownBaseline";

/** The draft or published article a review state is computed against. */
export type ReviewOwner = { articleDraftId: Uuid } | { sourceId: Uuid };

/**
 * Compares a recorded baseline against the owner's current revision.
 *
 * The comparison is strict identity, never text equality: reverting the
 * original from A to B and back to A produces a new snapshot, and a
 * translation reviewed against the first A stays `needsReview` until someone
 * acknowledges the new one. Text equality would silently clear that flag,
 * which contradicts the rule that acknowledging one revision says nothing
 * about any other.
 */
export function getReviewState(
  baselineId: Uuid | null | undefined,
  currentId: Uuid | null | undefined,
): TranslationReviewState {
  if (baselineId == null || currentId == null) return "unknownBaseline";
  return baselineId === currentId ? "current" : "needsReview";
}

/** Returns the snapshot the owner's current original text corresponds to. */
export function getCurrentRevisionForOwner(
  db: Database | Transaction,
  owner: ReviewOwner,
): Promise<ArticleSourceRevision | undefined> {
  return "articleDraftId" in owner
    ? getCurrentDraftRevision(db, owner.articleDraftId)
    : getCurrentSourceRevision(db, owner.sourceId);
}

export interface TranslationReviewStates {
  /** Current revision id, or `undefined` when the owner has no snapshot. */
  currentRevisionId: Uuid | undefined;
  /** Published language versions, keyed by language. Empty for a draft. */
  contents: Map<string, TranslationReviewState>;
  /** Private translation drafts, keyed by language. */
  drafts: Map<string, TranslationReviewState>;
}

/**
 * Computes review state for every translation under one draft or article in a
 * single place, so the editor, the public API and the federation serializer
 * cannot disagree.
 *
 * Read-only: it never records a missing snapshot, because a read that
 * fabricated a baseline would turn "freshness unverified" into a false claim.
 */
export async function getTranslationReviewStates(
  db: Database | Transaction,
  owner: ReviewOwner,
): Promise<TranslationReviewStates> {
  const current = await getCurrentRevisionForOwner(db, owner);
  const currentRevisionId = current?.id;
  const contents = new Map<string, TranslationReviewState>();
  if ("sourceId" in owner) {
    const rows = await db.query.articleContentTable.findMany({
      where: {
        sourceId: owner.sourceId,
        originalLanguage: { isNotNull: true },
      },
      columns: { language: true, sourceRevisionId: true },
    });
    for (const row of rows) {
      contents.set(
        row.language,
        getReviewState(row.sourceRevisionId, currentRevisionId),
      );
    }
  }
  const draftRows = await db.query.articleTranslationDraftTable.findMany({
    where: owner,
    columns: { language: true, sourceRevisionId: true },
  });
  const drafts = new Map<string, TranslationReviewState>();
  for (const row of draftRows) {
    drafts.set(
      row.language,
      getReviewState(row.sourceRevisionId, currentRevisionId),
    );
  }
  return { currentRevisionId, contents, drafts };
}

/** Provenance values that mark a published version as human-managed. */
const HUMAN_MANAGED_PROVENANCES = ["human", "llm_reviewed", "unknown"] as const;

interface OwnerInfo {
  accountId: Uuid;
  kind: "personal" | "organization";
  postId: Uuid | null;
}

async function getSourceOwner(
  db: Database | Transaction,
  sourceId: Uuid,
): Promise<OwnerInfo | undefined> {
  const source = await db.query.articleSourceTable.findFirst({
    where: { id: sourceId },
    columns: { accountId: true },
    with: {
      account: { columns: { kind: true } },
      post: { columns: { id: true } },
    },
  });
  if (source?.account == null) return undefined;
  return {
    accountId: source.accountId,
    kind: source.account.kind,
    postId: source.post?.id ?? null,
  };
}

/**
 * Groups the article's affected translations by the individual credited with
 * them.
 *
 * "Affected" means human-managed and not `current`: published versions whose
 * provenance is not a bare automatic translation, plus the private translation
 * drafts attached to the published article. Automatic versions are excluded
 * because nobody is credited with them.
 */
async function collectAffectedLanguagesByTranslator(
  db: Database | Transaction,
  sourceId: Uuid,
): Promise<Map<Uuid, Set<string>>> {
  const states = await getTranslationReviewStates(db, { sourceId });
  const affected = new Map<Uuid, Set<string>>();
  const add = (translatorId: Uuid, language: string) => {
    const languages = affected.get(translatorId) ?? new Set<string>();
    languages.add(language);
    affected.set(translatorId, languages);
  };
  const contents = await db.query.articleContentTable.findMany({
    where: {
      sourceId,
      originalLanguage: { isNotNull: true },
      translatorId: { isNotNull: true },
      provenance: { in: [...HUMAN_MANAGED_PROVENANCES] },
    },
    columns: { language: true, translatorId: true },
  });
  for (const content of contents) {
    if (content.translatorId == null) continue;
    if (states.contents.get(content.language) === "current") continue;
    add(content.translatorId, content.language);
  }
  const drafts = await db.query.articleTranslationDraftTable.findMany({
    where: { sourceId, translatorId: { isNotNull: true } },
    columns: { language: true, translatorId: true },
  });
  for (const draft of drafts) {
    if (draft.translatorId == null) continue;
    if (states.drafts.get(draft.language) === "current") continue;
    add(draft.translatorId, draft.language);
  }
  return affected;
}

export interface SyncTranslationReviewNotificationsOptions {
  /**
   * `sourceChanged` runs from the new-source-revision path: it creates,
   * updates and deletes rows, and resurfaces a changed row as unread.
   *
   * `reconcile` runs after a review action: it only updates and deletes rows
   * that already exist, and never resurfaces them. It must not create rows,
   * because self-suppression is a decision taken at edit time and is not
   * stored anywhere; a creating reconcile would resurrect exactly the
   * notification the source editor's own edit deliberately skipped.
   *
   * Either way, a recipient whose translations are all reviewed (or who has
   * lost access) has their row deleted: an outstanding notification is a piece
   * of live state, not an audit record.
   */
  mode: "sourceChanged" | "reconcile";
  /** The editing individual, whose own translations are not notified. */
  suppressAccountId?: Uuid | null;
}

export interface PendingTranslationReviewPush {
  accountId: Uuid;
  notificationId: Uuid;
  actorId: Uuid;
  postId: Uuid;
}

/**
 * Brings the article's outstanding "original changed" notifications in line
 * with its current review state.
 *
 * The caller must already hold the `article_source` row lock, so that two
 * edits (or an edit and a review) cannot compute conflicting sets. Returns the
 * rows whose delivery should be pushed after the transaction commits; the
 * caller re-verifies each one before delivering.
 */
export async function syncTranslationReviewNotifications(
  db: Transaction | Database,
  sourceId: Uuid,
  options: SyncTranslationReviewNotificationsOptions,
): Promise<PendingTranslationReviewPush[]> {
  // `pg_advisory_xact_lock` lives and dies with its transaction, so the whole
  // reconciliation has to run inside one. Handed a root `Database`, each
  // statement would otherwise be its own transaction and the lock would be
  // released before the membership reads and notification writes it is meant
  // to serialize.
  return await runInTransaction(db, (tx) =>
    syncTranslationReviewNotificationsInTransaction(tx, sourceId, options),
  );
}

async function syncTranslationReviewNotificationsInTransaction(
  db: Transaction,
  sourceId: Uuid,
  options: SyncTranslationReviewNotificationsOptions,
): Promise<PendingTranslationReviewPush[]> {
  const owner = await getSourceOwner(db, sourceId);
  if (owner == null || owner.postId == null) return [];
  // Serialize against membership revocation on the same advisory lock the
  // organization code uses, so a member removed concurrently cannot end up
  // with a row inserted after their rows were deleted.
  if (owner.kind === "organization") {
    await lockOrganizationMembershipSet(db, owner.accountId);
  }
  const ownerActor = await db.query.actorTable.findFirst({
    where: { accountId: owner.accountId },
    columns: { id: true },
  });
  if (ownerActor == null) return [];
  const current = await getCurrentSourceRevision(db, sourceId);
  const existing = await db
    .select({
      id: notificationTable.id,
      accountId: notificationTable.accountId,
      revisionId: notificationTable.articleSourceRevisionId,
      languages: notificationTable.translationLanguages,
    })
    .from(notificationTable)
    .where(
      and(
        eq(notificationTable.type, "article_translation_source_changed"),
        eq(notificationTable.postId, owner.postId),
      ),
    );
  const existingByAccount = new Map(
    existing.map((row) => [row.accountId, row]),
  );
  const affected = await collectAffectedLanguagesByTranslator(db, sourceId);
  const desired = new Map<Uuid, string[]>();
  for (const [translatorId, languages] of affected) {
    if (
      !(await canAccountActAs(
        db,
        { id: translatorId, kind: "personal" },
        owner.accountId,
      ))
    ) {
      continue;
    }
    desired.set(translatorId, [...languages].sort());
  }
  const obsolete = existing
    .filter((row) => !desired.has(row.accountId))
    .map((row) => row.id);
  if (obsolete.length > 0) {
    await db
      .delete(notificationTable)
      .where(inArray(notificationTable.id, obsolete));
  }
  if (current == null) return [];
  const pending: PendingTranslationReviewPush[] = [];
  for (const [accountId, languages] of desired) {
    const previous = existingByAccount.get(accountId);
    // Self-suppression means "do not notify the editor about their own edit",
    // not "forget what someone else's edit already raised": an outstanding row
    // for the editor keeps its place in the list and is updated in step with
    // the article, but is never created or resurfaced by their own edit.
    const raises =
      options.mode === "sourceChanged" &&
      accountId !== options.suppressAccountId;
    const unchanged =
      previous != null &&
      previous.revisionId === current.id &&
      previous.languages.length === languages.length &&
      previous.languages.every((language, i) => language === languages[i]);
    if (unchanged) continue;
    if (previous == null) {
      if (!raises) continue;
      const rows = await db
        .insert(notificationTable)
        .values({
          id: generateUuidV7(),
          accountId,
          type: "article_translation_source_changed",
          postId: owner.postId,
          actorIds: [ownerActor.id],
          articleSourceRevisionId: current.id,
          translationLanguages: languages,
          // `clock_timestamp()` rather than `CURRENT_TIMESTAMP`: the latter is
          // the transaction's start time, which can predate the recipient's
          // last `markNotificationsAsRead` and leave a fresh notification
          // already read.
          created: sql`clock_timestamp()`,
        })
        .onConflictDoNothing()
        .returning({ id: notificationTable.id });
      if (rows[0] != null) {
        pending.push({
          accountId,
          notificationId: rows[0].id,
          actorId: ownerActor.id,
          postId: owner.postId,
        });
      }
      continue;
    }
    await db
      .update(notificationTable)
      .set({
        articleSourceRevisionId: current.id,
        translationLanguages: languages,
        ...(raises
          ? {
              actorIds: sql`
                CASE
                  WHEN ${ownerActor.id} = ANY(${notificationTable.actorIds})
                  THEN ${notificationTable.actorIds}
                  ELSE array_append(${notificationTable.actorIds}, ${ownerActor.id})
                END
              `,
              created: sql`clock_timestamp()`,
            }
          : {}),
      })
      .where(eq(notificationTable.id, previous.id));
    if (raises) {
      pending.push({
        accountId,
        notificationId: previous.id,
        actorId: ownerActor.id,
        postId: owner.postId,
      });
    }
  }
  return pending;
}

/**
 * Re-checks that a queued push is still warranted after the transaction
 * committed: the row may have been resolved, or the recipient may have lost
 * access to the workspace in the meantime.
 */
export async function isTranslationReviewPushStillValid(
  db: Database,
  push: PendingTranslationReviewPush,
): Promise<boolean> {
  const notification = await db.query.notificationTable.findFirst({
    where: {
      id: push.notificationId,
      type: "article_translation_source_changed",
    },
    columns: { accountId: true, translationLanguages: true, postId: true },
  });
  if (notification == null) return false;
  if (notification.translationLanguages.length < 1) return false;
  const post = await db.query.postTable.findFirst({
    where: { id: push.postId },
    columns: { articleSourceId: true },
  });
  if (post?.articleSourceId == null) return false;
  const owner = await getSourceOwner(db, post.articleSourceId);
  if (owner == null) return false;
  return await canAccountActAs(
    db,
    { id: notification.accountId, kind: "personal" },
    owner.accountId,
  );
}

export interface AcknowledgeArticleTranslationSourceInput {
  owner: ReviewOwner;
  language: string;
  sourceRevisionId: Uuid;
  /** Optimistic token echoed from the translation draft being acknowledged. */
  translationDraftRevision?: number | null;
}

export type AcknowledgeArticleTranslationSourceResult =
  | {
      status: "ok";
      translationDraft: ArticleTranslationDraft | undefined;
      content: ArticleContent | undefined;
      /**
       * Whether the published version's baseline actually moved, which
       * changes the article's public freshness and therefore needs an
       * `Update`. Acknowledging a draft only, or re-acknowledging the same
       * revision, leaves it `false`.
       */
      publishedBaselineChanged: boolean;
    }
  | { status: "conflict"; currentRevision: number }
  | { status: "invalid"; inputPath: string }
  | { status: "forbidden" };

/**
 * Records that an authorized editor compared a translation against a specific
 * source revision and decided it needs no change.
 *
 * The acknowledged revision is stored verbatim. If the original moved while
 * the comparison was open, the older revision is what gets recorded and the
 * translation stays `needsReview`, which is the point: an acknowledgement
 * speaks only for the revision that was actually read.
 *
 * It advances the private draft's baseline as well as the published version's,
 * because publishing copies the draft's baseline; without this, a translator
 * who reacts to a source change could never publish a version that reads as
 * current. The draft's optimistic `revision` is deliberately *not* bumped: it
 * distinguishes "published" from "published with unpublished changes", and no
 * text changed here.
 *
 * A published version whose automatic translation is still running is skipped:
 * there is no reviewable text there yet.
 */
export async function acknowledgeArticleTranslationSource(
  db: Database | Transaction,
  viewer: Pick<Account, "id" | "kind">,
  input: AcknowledgeArticleTranslationSourceInput,
): Promise<AcknowledgeArticleTranslationSourceResult> {
  const language = normalizeContentLanguage(input.language);
  if (language == null) return { status: "invalid", inputPath: "language" };
  const draftRevision = input.translationDraftRevision ?? null;
  if (
    draftRevision != null &&
    (!Number.isInteger(draftRevision) || draftRevision < 1)
  ) {
    return { status: "invalid", inputPath: "translationDraftRevision" };
  }
  const ownerPath =
    "articleDraftId" in input.owner ? "articleDraftId" : "sourceId";
  return await runInTransaction(
    db,
    async (tx): Promise<AcknowledgeArticleTranslationSourceResult> => {
      // Owner first, then the translation draft: `saveArticleTranslationDraft`
      // takes the owner lock before creating a language, so holding it here
      // also closes the window where the language's draft appears between the
      // lookup and the update.
      let ownerAccountId: Uuid;
      if ("articleDraftId" in input.owner) {
        const rows = await tx
          .select({ accountId: articleDraftTable.accountId })
          .from(articleDraftTable)
          .where(eq(articleDraftTable.id, input.owner.articleDraftId))
          .for("update");
        if (rows[0] == null) return { status: "invalid", inputPath: ownerPath };
        ownerAccountId = rows[0].accountId;
      } else {
        const rows = await tx
          .select({ accountId: articleSourceTable.accountId })
          .from(articleSourceTable)
          .where(eq(articleSourceTable.id, input.owner.sourceId))
          .for("update");
        if (rows[0] == null) return { status: "invalid", inputPath: ownerPath };
        ownerAccountId = rows[0].accountId;
      }
      if (!(await canAccountActAs(tx, viewer, ownerAccountId))) {
        return { status: "forbidden" };
      }
      const revision = await tx.query.articleSourceRevisionTable.findFirst({
        where: { id: input.sourceRevisionId },
      });
      const belongsToOwner =
        revision != null &&
        ("articleDraftId" in input.owner
          ? revision.articleDraftId === input.owner.articleDraftId
          : revision.sourceId === input.owner.sourceId);
      if (!belongsToOwner) {
        return { status: "invalid", inputPath: "sourceRevisionId" };
      }
      const draftRows = await tx
        .select()
        .from(articleTranslationDraftTable)
        .where(
          and(
            "articleDraftId" in input.owner
              ? eq(
                  articleTranslationDraftTable.articleDraftId,
                  input.owner.articleDraftId,
                )
              : eq(articleTranslationDraftTable.sourceId, input.owner.sourceId),
            eq(articleTranslationDraftTable.language, language),
          ),
        )
        .for("update");
      const existingDraft = draftRows[0];
      if (existingDraft != null && draftRevision != null) {
        if (existingDraft.revision !== draftRevision) {
          return {
            status: "conflict",
            currentRevision: existingDraft.revision,
          };
        }
      }
      let translationDraft: ArticleTranslationDraft | undefined;
      if (existingDraft != null) {
        const updated = await tx
          .update(articleTranslationDraftTable)
          .set({
            sourceRevisionId: input.sourceRevisionId,
            reviewerId: viewer.id,
            reviewed: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(articleTranslationDraftTable.id, existingDraft.id))
          .returning();
        translationDraft = updated[0];
      }
      let content: ArticleContent | undefined;
      let publishedBaselineChanged = false;
      if ("sourceId" in input.owner) {
        const before = await tx.query.articleContentTable.findFirst({
          where: { sourceId: input.owner.sourceId, language },
          columns: { sourceRevisionId: true },
        });
        const updated = await tx
          .update(articleContentTable)
          .set({
            sourceRevisionId: input.sourceRevisionId,
            reviewerId: viewer.id,
            reviewed: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            and(
              eq(articleContentTable.sourceId, input.owner.sourceId),
              eq(articleContentTable.language, language),
              sql`${articleContentTable.originalLanguage} IS NOT NULL`,
              // An automatic translation still in flight holds the original's
              // text as a placeholder, and its worker will overwrite the row
              // when the model answers. Certifying it would attach a reviewer
              // and a baseline to text nobody has seen, and the worker's own
              // CAS would keep them while replacing the body.
              eq(articleContentTable.beingTranslated, false),
            ),
          )
          .returning();
        content = updated[0];
        publishedBaselineChanged =
          content != null &&
          content.sourceRevisionId !== (before?.sourceRevisionId ?? null);
      }
      if (translationDraft == null && content == null) {
        return { status: "invalid", inputPath: "language" };
      }
      if ("sourceId" in input.owner) {
        await syncTranslationReviewNotifications(tx, input.owner.sourceId, {
          mode: "reconcile",
        });
      }
      return {
        status: "ok",
        translationDraft,
        content,
        publishedBaselineChanged,
      };
    },
  );
}
