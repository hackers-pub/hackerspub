import * as vocab from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { eq, sql } from "drizzle-orm";
import { getArticleSourceMediumUrls } from "./article-source.ts";
import {
  getPublishedTranslationMetadata,
  type PublishedTranslationMetadata,
} from "./article-translation-metadata.ts";
import type { ApplicationContext } from "./context.ts";
import type { Database, Transaction } from "./db.ts";
import { getMissingArticleMediumLabel, renderMarkup } from "./markup.ts";
import {
  articleSourceTable,
  type NewPostContentVariant,
  postContentVariantTable,
  postTable,
} from "./schema.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "article-publication"]);

/**
 * The SQL expression for the next object version of an article source.
 *
 * `CURRENT_TIMESTAMP` is the enclosing transaction's start time, so two
 * serialized writers can produce equal or even decreasing values. Receivers
 * order `Update` activities by the object's `updated`, and FEP-22cd compares
 * `sourceUpdated` against it, so every public change must move it strictly
 * forward. Truncating to milliseconds matches the precision peers keep.
 *
 * Only use it while holding the `article_source` row lock (an `UPDATE` of the
 * row takes it implicitly).
 */
export function nextArticleVersionSql() {
  return sql`GREATEST(
    date_trunc('milliseconds', clock_timestamp()),
    date_trunc('milliseconds', ${articleSourceTable.updated})
      + interval '1 millisecond'
  )`;
}

/**
 * Advances an article source's object version, returning the new value.
 * The caller must hold the `article_source` row lock.
 */
export async function bumpArticleVersion(
  db: Database | Transaction,
  sourceId: Uuid,
): Promise<Date | undefined> {
  const rows = await db
    .update(articleSourceTable)
    .set({ updated: nextArticleVersionSql() })
    .where(eq(articleSourceTable.id, sourceId))
    .returning({ updated: articleSourceTable.updated });
  return rows[0]?.updated;
}

/** Takes the `article_source` row lock. */
export async function lockArticleSource(
  db: Database | Transaction,
  sourceId: Uuid,
): Promise<boolean> {
  const rows = await db
    .select({ id: articleSourceTable.id })
    .from(articleSourceTable)
    .where(eq(articleSourceTable.id, sourceId))
    .for("update");
  return rows.length > 0;
}

/** The identifier of the instance actor, credited for machine translation. */
export function getInstanceActorIdentifier(
  ctx: Pick<ApplicationContext, "canonicalOrigin">,
): string {
  return new URL(ctx.canonicalOrigin).hostname;
}

/**
 * The actor IRIs credited for a published translation, exactly as they are
 * federated in the FEP-22cd `translator` set.
 *
 * Machine output is credited to the instance actor, which is an
 * `Application`, so peers classify it as machine translation; a human
 * reviewer of machine output is credited alongside it. A deleted translator
 * keeps their actor IRI, which now dereferences to a `Tombstone`. A legacy
 * version whose provenance and translator are both unknown has no IRI at all.
 */
export function getTranslatorIris(
  ctx: Pick<ApplicationContext, "canonicalOrigin" | "getActorUri">,
  metadata: Pick<
    PublishedTranslationMetadata,
    "machine" | "translatorAccountId"
  >,
): URL[] {
  const iris: URL[] = [];
  if (metadata.machine) {
    iris.push(ctx.getActorUri(getInstanceActorIdentifier(ctx)));
  }
  if (metadata.translatorAccountId != null) {
    iris.push(ctx.getActorUri(metadata.translatorAccountId));
  }
  return iris;
}

/**
 * The public URL of an article, optionally for one language version.
 *
 * Pass the original's language too when a link must open the original
 * itself: the bare article path can negotiate to the reader's preferred
 * translation.
 */
export function getArticleLanguageUrl(
  origin: string,
  article: { username: string; publishedYear: number; slug: string },
  language?: string,
): URL {
  const path = `/@${article.username}/${article.publishedYear}/${encodeURIComponent(
    article.slug,
  )}`;
  return new URL(
    language == null ? path : `${path}/${encodeURIComponent(language)}`,
    origin,
  );
}

/**
 * Rebuilds the `post_content_variant` rows of a local article from its
 * published, completed `article_content` rows.
 *
 * The caller must hold the `article_source` row lock, so the rows read here
 * are exactly what is being published. Placeholders of running automatic
 * translations are never materialized: they hold the original's text.
 * Summaries follow later through {@link syncArticleContentVariantSummary}.
 */
export async function syncArticleContentVariants(
  ctx: ApplicationContext,
  sourceId: Uuid,
): Promise<void> {
  const { db } = ctx;
  const source = await db.query.articleSourceTable.findFirst({
    where: { id: sourceId },
    with: {
      account: { columns: { username: true } },
      contents: true,
      post: { with: { organizationAuthor: true } },
    },
  });
  if (source?.post == null) return;
  const post = source.post;
  const metadata = await getPublishedTranslationMetadata(
    db,
    source,
    source.contents,
    post.organizationAuthor,
  );
  const mediumUrls = await getArticleSourceMediumUrls(
    db,
    ctx.storage,
    source.id,
  );
  const article = {
    username: source.account.username,
    publishedYear: source.publishedYear,
    slug: source.slug,
  };
  const rows: NewPostContentVariant[] = [];
  for (const content of source.contents) {
    if (content.beingTranslated) continue;
    const translation = metadata.get(content.language);
    if (content.originalLanguage != null && translation == null) continue;
    const rendered = await renderMarkup(ctx, content.content, {
      docId: source.id,
      kv: ctx.kv,
      mediumUrls,
      missingMediumLabel: getMissingArticleMediumLabel(content.language),
    });
    rows.push({
      id: generateUuidV7(),
      postId: post.id,
      language: content.language,
      default: content.originalLanguage == null,
      originalLanguage: content.originalLanguage,
      url:
        content.originalLanguage == null
          ? post.url
          : getArticleLanguageUrl(ctx.origin, article, content.language).href,
      name: content.title,
      summary: content.summary,
      contentHtml: rendered.html,
      translationKind: translation?.kind ?? null,
      translatorIris:
        translation == null
          ? []
          : getTranslatorIris(ctx, translation).map((iri) => iri.href),
      freshness: translation?.freshness ?? null,
      sourceUpdated: translation?.sourceUpdated ?? null,
    });
  }
  await db
    .delete(postContentVariantTable)
    .where(eq(postContentVariantTable.postId, post.id));
  if (rows.length > 0) await db.insert(postContentVariantTable).values(rows);
}

/**
 * Mirrors a newly applied summary onto the matching materialized variant.
 * The caller must hold the `article_source` row lock.
 */
export async function syncArticleContentVariantSummary(
  db: Database | Transaction,
  sourceId: Uuid,
  language: string,
  summary: string | null,
): Promise<void> {
  const post = await db.query.postTable.findFirst({
    where: { articleSourceId: sourceId },
    columns: { id: true },
  });
  if (post == null) return;
  await db
    .update(postContentVariantTable)
    .set({ summary })
    .where(
      sql`${postContentVariantTable.postId} = ${post.id}
        AND ${postContentVariantTable.language} = ${language}`,
    );
}

export interface PublishArticleStateOptions {
  /**
   * Whether to advance the object version first. Callers that already moved
   * it in the same transaction (a source edit) pass `false`.
   */
  readonly bump?: boolean;
}

/**
 * Makes a change to a published article's public state visible: advances its
 * object version, rematerializes its content variants, and federates an
 * `Update` built from the state inside the caller's transaction.
 *
 * Every path that changes what readers or peers see of a local article (a
 * source edit, a translation publication or withdrawal, a review
 * acknowledgement that moves a published baseline, an automatic translation
 * finishing) goes through here, so the local reader surfaces and the
 * federated object cannot diverge. The caller must hold the `article_source`
 * row lock in the transaction of `ctx`; `sendActivity` then enqueues into the
 * transactional outbox, so activities leave in commit order and only if the
 * change commits.
 *
 * A censored article still gets its variants rebuilt, but nothing federates.
 * The `Update` is always sent by the owning account: translator credit
 * grants no publishing authority.
 */
export async function publishArticleState(
  ctx: ApplicationContext,
  sourceId: Uuid,
  options: PublishArticleStateOptions = {},
): Promise<void> {
  const { db } = ctx;
  if (options.bump ?? true) await bumpArticleVersion(db, sourceId);
  await syncArticleContentVariants(ctx, sourceId);
  const source = await db.query.articleSourceTable.findFirst({
    where: { id: sourceId },
    with: { account: true, contents: true, post: true },
  });
  if (source == null) return;
  const post = source.post;
  if (post?.censored != null) return;
  const articleObject = await ctx.services.federation.getArticle(ctx, source);
  const orderingKey =
    post?.iri ?? ctx.getObjectUri(vocab.Article, { id: source.id }).href;
  const activity = new vocab.Update({
    // Unique per event: two changes can share a millisecond-truncated
    // `updated` only if something bypassed the monotonic bump, and
    // receivers deduplicate activities by id.
    id: new URL(
      `#update/${source.updated.toISOString()}/${generateUuidV7()}`,
      articleObject.id ?? ctx.canonicalOrigin,
    ),
    actor: ctx.getActorUri(source.accountId),
    tos: articleObject.toIds,
    ccs: articleObject.ccIds,
    object: articleObject,
  });
  await ctx.sendActivity(
    { identifier: source.accountId },
    "followers",
    activity,
    {
      orderingKey,
      preferSharedInbox: true,
      excludeBaseUris: [new URL(ctx.origin), new URL(ctx.canonicalOrigin)],
    },
  );
  if (post == null) return;
  const relayedTags = await ctx.services.federation.sendTagsPubRelayActivity(
    ctx,
    source.accountId,
    activity,
    {
      orderingKey,
      visibility: post.visibility,
      accountBio: source.account.bio,
      relayedTags: post.relayedTags,
    },
  );
  if (relayedTags != null) {
    await db
      .update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, post.id));
  }
  logger.debug("Published the public state of article {sourceId}.", {
    sourceId,
  });
}
