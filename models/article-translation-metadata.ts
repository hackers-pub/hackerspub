import type { Database, Transaction } from "./db.ts";
import {
  getTranslationReviewStates,
  type TranslationReviewState,
} from "./article-translation-review.ts";
import type {
  ArticleContent,
  ArticleSource,
  OrganizationPostAuthor,
  PostTranslationFreshness,
  PostTranslationKind,
} from "./schema.ts";
import type { Uuid } from "./uuid.ts";

/**
 * Everything the public surfaces (the ActivityPub serializer and the
 * materialized post content variants) say about one published translation.
 *
 * It is computed in one place so that the federated `Translation` entry, the
 * readable HTML credit and notice, and the variant row cannot disagree with
 * each other or with the editor's review state.
 */
export interface PublishedTranslationMetadata {
  readonly language: string;
  readonly originalLanguage: string;
  /** How the version was produced; `unknown` for legacy rows. */
  readonly kind: PostTranslationKind;
  /** Review state from the shared revision-identity helper. */
  readonly reviewState: TranslationReviewState;
  /** Reader-facing freshness derived from {@link reviewState}. */
  readonly freshness: PostTranslationFreshness;
  /**
   * The credited individual's account ID, still resolvable after the account
   * was deleted (through `article_content.deleted_translator_id`), so that
   * the federated credit keeps naming the same actor.
   */
  readonly translatorAccountId: Uuid | null;
  /** Whether {@link translatorAccountId} belongs to a deleted account. */
  readonly translatorDeleted: boolean;
  /**
   * Whether the credited individual is presented to readers as the article's
   * author, so the credit can read "translated by the author".
   */
  readonly translatorIsAuthor: boolean;
  /** Whether the machine translator is part of the credit. */
  readonly machine: boolean;
  /**
   * The FEP-22cd `sourceUpdated` value, or `null` when no freshness claim is
   * made (automatic output, which no person reviewed, and unknown
   * baselines).
   */
  readonly sourceUpdated: Date | null;
}

/**
 * The ActivityPub reference timestamp of an article object: `updated` when the
 * object has been updated since publication, otherwise `published`.
 *
 * It mirrors how the serializer decides whether to emit `updated` at all, so
 * `sourceUpdated` values compare against exactly what peers receive.
 */
export function getArticleReferenceTime(
  source: Pick<ArticleSource, "updated" | "published">,
): Date {
  return +source.updated > +source.published
    ? source.updated
    : source.published;
}

function kindOf(content: ArticleContent): PostTranslationKind {
  switch (content.provenance) {
    case "human":
      return "human";
    case "llm":
      return "machine";
    case "llm_reviewed":
      return "machine_reviewed";
    default:
      return "unknown";
  }
}

function freshnessOf(state: TranslationReviewState): PostTranslationFreshness {
  switch (state) {
    case "current":
      return "current";
    case "needsReview":
      return "source_changed";
    default:
      return "unknown";
  }
}

/**
 * Computes {@link PublishedTranslationMetadata} for every published,
 * completed translation of an article.
 *
 * Rows an automatic translation job is still filling (`beingTranslated`) are
 * skipped: they hold the original's text, and describing them as a
 * translation would publish that text under the wrong language.
 *
 * @param source The article source, with the timestamps the serializer emits.
 * @param contents The source's `article_content` rows.
 * @param organizationAuthor The post's organization authorship record, used to
 *                           decide who is presented as the author.
 */
export async function getPublishedTranslationMetadata(
  db: Database | Transaction,
  source: Pick<ArticleSource, "id" | "accountId" | "updated" | "published">,
  contents: readonly ArticleContent[],
  organizationAuthor?: Pick<
    OrganizationPostAuthor,
    "organizationAccountId" | "memberAccountId" | "attributionMode"
  > | null,
): Promise<Map<string, PublishedTranslationMetadata>> {
  const result = new Map<string, PublishedTranslationMetadata>();
  const translations = contents.filter(
    (content) => content.originalLanguage != null && !content.beingTranslated,
  );
  if (translations.length < 1) return result;
  const states = await getTranslationReviewStates(db, { sourceId: source.id });
  const baselineIds = [
    ...new Set(
      translations
        .map((content) => content.sourceRevisionId)
        .filter((id): id is Uuid => id != null),
    ),
  ];
  const baselines =
    baselineIds.length < 1
      ? []
      : await db.query.articleSourceRevisionTable.findMany({
          where: { id: { in: baselineIds } },
          columns: { id: true, publicUntil: true },
        });
  const publicUntil = new Map(
    baselines.map((revision) => [revision.id, revision.publicUntil]),
  );
  const authorIds = new Set<Uuid>([source.accountId]);
  if (
    organizationAuthor?.attributionMode === "acting_account_with_viewer" &&
    organizationAuthor.organizationAccountId === source.accountId &&
    organizationAuthor.memberAccountId != null
  ) {
    authorIds.add(organizationAuthor.memberAccountId);
  }
  const reference = getArticleReferenceTime(source);
  for (const content of translations) {
    const kind = kindOf(content);
    const reviewState =
      states.contents.get(content.language) ?? "unknownBaseline";
    let sourceUpdated: Date | null = null;
    // FEP-22cd defines `sourceUpdated` as the reference value as of the last
    // *human* review, so unreviewed machine output never carries one, and an
    // unknown baseline makes no claim either. A translation reviewed against
    // the current revision reflects the current source and reports the
    // current reference value (the FEP treats equal or later values as
    // current), which keeps it current across Updates that change only other
    // languages. A stale one reports the last reference value peers were told
    // while its baseline was current, recorded when that baseline was
    // superseded; if that fact was never recorded, no claim is made.
    if (kind !== "machine") {
      if (reviewState === "current") {
        sourceUpdated = reference;
      } else if (
        reviewState === "needsReview" &&
        content.sourceRevisionId != null
      ) {
        const until = publicUntil.get(content.sourceRevisionId) ?? null;
        if (until != null && +until < +reference) sourceUpdated = until;
      }
    }
    const translatorAccountId =
      content.translatorId ?? content.deletedTranslatorId ?? null;
    result.set(content.language, {
      language: content.language,
      originalLanguage: content.originalLanguage!,
      kind,
      reviewState,
      freshness: freshnessOf(reviewState),
      translatorAccountId,
      translatorDeleted:
        content.translatorId == null && content.deletedTranslatorId != null,
      translatorIsAuthor:
        content.translatorId != null && authorIds.has(content.translatorId),
      machine: kind === "machine" || kind === "machine_reviewed",
      sourceUpdated,
    });
  }
  return result;
}
