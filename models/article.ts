import type { Context } from "@fedify/fedify";
import { assertAccountActorNotSuspended } from "./moderation.ts";
import * as vocab from "@fedify/vocab";
import {
  removeDetailsFromSummaryInput,
  summarize,
} from "@hackerspub/ai/summary";
import { translate } from "@hackerspub/ai/translate";
import { getArticle } from "@hackerspub/federation/objects";
import { sendTagsPubRelayActivity } from "@hackerspub/federation/tags-pub";
import { getLogger } from "@logtape/logtape";
import { minBy } from "@std/collections/min-by";
import type { LanguageModel } from "ai";
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
import type { Disk } from "flydrive";
import postgres from "postgres";
import type { ContextData, Models } from "./context.ts";
import type { Database, Transaction } from "./db.ts";
import { syncPostFromArticleSource } from "./post.ts";
import {
  type Account,
  type AccountEmail,
  type AccountLink,
  type Actor,
  type ArticleContent,
  articleContentTable,
  type ArticleDraft,
  articleDraftTable,
  type ArticleSource,
  articleSourceMediumTable,
  articleSourceTable,
  type Blocking,
  type Following,
  type Instance,
  type Mention,
  type NewArticleDraft,
  type NewArticleSource,
  type Post,
  postTable,
  type Reaction,
} from "./schema.ts";
import { addPostToTimeline } from "./timeline.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "article"]);
const articleMediumReferencePattern = /hp-medium:([A-Za-z0-9._:/-]+)/g;
const articleMediumKeyPattern = /^[A-Za-z0-9._:/-]+$/;

interface ArticleMediumInput {
  key: string;
  mediumId: Uuid;
}

class InvalidArticleSourceMediumError extends Error {
}

function extractArticleMediumKeys(content: string): Set<string> {
  return new Set(
    [...content.matchAll(articleMediumReferencePattern)].map((match) =>
      match[1]
    ),
  );
}

async function updateArticleSourceMedia(
  db: Database | Transaction,
  articleSourceId: Uuid,
  content: string,
  sourceMedia: readonly ArticleMediumInput[] | undefined,
): Promise<boolean> {
  const referencedMediumKeys = extractArticleMediumKeys(content);
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
  const missingKeys = [...referencedMediumKeys].filter((key) =>
    !existingMediaByKey.has(key) && !sourceMediaByKey.has(key)
  );
  if (missingKeys.length > 0) return false;
  const referencedSourceMedia = [...referencedMediumKeys]
    .map((key) => sourceMediaByKey.get(key))
    .filter((medium) => medium != null);
  const referencedMediumIds = [
    ...new Set(
      referencedSourceMedia.map((medium) => medium.mediumId),
    ),
  ];
  if (referencedMediumIds.length > 0) {
    const storedMedia = await db.query.mediumTable.findMany({
      where: { id: { in: referencedMediumIds } },
      columns: { id: true },
    });
    if (storedMedia.length !== referencedMediumIds.length) return false;
  }
  if (referencedMediumKeys.size < 1) {
    await db.delete(articleSourceMediumTable)
      .where(eq(articleSourceMediumTable.articleSourceId, articleSourceId));
  } else {
    await db.delete(articleSourceMediumTable)
      .where(and(
        eq(articleSourceMediumTable.articleSourceId, articleSourceId),
        notInArray(articleSourceMediumTable.key, [...referencedMediumKeys]),
      ));
  }
  if (referencedSourceMedia.length > 0) {
    await db.insert(articleSourceMediumTable).values(
      referencedSourceMedia.map((medium) => ({
        articleSourceId,
        key: medium.key,
        mediumId: medium.mediumId,
      })),
    ).onConflictDoUpdate({
      target: [
        articleSourceMediumTable.articleSourceId,
        articleSourceMediumTable.key,
      ],
      set: { mediumId: sql`excluded.medium_id` },
    });
  }
  return true;
}

export async function getArticleDraftMediumUrls(
  db: Database,
  disk: Disk,
  draftId: Uuid,
): Promise<Record<string, string>> {
  const media = await db.query.articleDraftMediumTable.findMany({
    where: { articleDraftId: draftId },
    with: { medium: true },
  });
  return Object.fromEntries(
    await Promise.all(
      media.map(async (relation) => [
        relation.key,
        await disk.getUrl(relation.medium.key),
      ]),
    ),
  );
}

export async function getArticleSourceMediumUrls(
  db: Database,
  disk: Disk,
  sourceId: Uuid,
): Promise<Record<string, string>> {
  const media = await db.query.articleSourceMediumTable.findMany({
    where: { articleSourceId: sourceId },
    with: { medium: true },
  });
  return Object.fromEntries(
    await Promise.all(
      media.map(async (relation) => [
        relation.key,
        await disk.getUrl(relation.medium.key),
      ]),
    ),
  );
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

export async function getArticleSource(
  db: Database,
  username: string,
  publishedYear: number,
  slug: string,
  signedAccount: Account & { actor: Actor } | undefined,
): Promise<
  ArticleSource & {
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
  } | undefined
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
            where: signedAccount == null
              ? { RAW: sql`false` }
              : { actorId: signedAccount.actor.id },
          },
          reactions: {
            where: signedAccount == null
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

export async function createArticleSource(
  db: Database,
  models: Models,
  source: Omit<NewArticleSource, "id"> & {
    id?: Uuid;
    title: string;
    content: string;
    language: string;
  },
): Promise<ArticleSource & { contents: ArticleContent[] } | undefined> {
  const sources = await db.insert(articleSourceTable)
    .values({ id: generateUuidV7(), ...source })
    .onConflictDoNothing()
    .returning();
  if (sources.length < 1) return undefined;
  const contents = await db.insert(articleContentTable)
    .values({
      sourceId: sources[0].id,
      language: source.language,
      title: source.title,
      content: source.content,
    })
    .returning();
  await startArticleContentSummary(db, models.summarizer, contents[0]);
  return { ...sources[0], contents };
}

export async function createArticle(
  fedCtx: Context<ContextData>,
  source: Omit<NewArticleSource, "id"> & {
    id?: Uuid;
    title: string;
    content: string;
    language: string;
    media?: readonly {
      key: string;
      mediumId: Uuid;
    }[];
  },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    articleSource: ArticleSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      contents: ArticleContent[];
    };
  } | undefined
> {
  const { db } = fedCtx.data;
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
    fedCtx.data.models,
    articleSourceInput,
  );
  if (articleSource == null) return undefined;
  const media = sourceMedia
    ?.filter((medium) => referencedMediumKeys.has(medium.key))
    .map((medium) => ({
      articleSourceId: articleSource.id,
      key: medium.key,
      mediumId: medium.mediumId,
    })) ?? [];
  if (media.length > 0) {
    await db.insert(articleSourceMediumTable).values(media)
      .onConflictDoNothing();
  }
  const account = await db.query.accountTable.findFirst({
    where: { id: source.accountId },
    with: { avatarMedium: true, emails: true, links: true },
  });
  if (account == undefined) return undefined;
  await assertAccountActorNotSuspended(db, account.id);
  const post = await syncPostFromArticleSource(fedCtx, {
    ...articleSource,
    account,
  });
  await addPostToTimeline(db, post);
  const articleObject = await getArticle(fedCtx, { ...articleSource, account });
  const activity = new vocab.Create({
    id: new URL("#create", articleObject.id ?? fedCtx.origin),
    actors: articleObject.attributionIds,
    tos: articleObject.toIds,
    ccs: articleObject.ccIds,
    object: articleObject,
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
  const relayedTags = await sendTagsPubRelayActivity(
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
    await db.update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, post.id));
    post.relayedTags = [...relayedTags];
  }
  // TODO: send Create(Article) to the mentioned actors too
  return post;
}

export interface UpdateArticleSourceResult {
  source: ArticleSource & { contents: ArticleContent[] };
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
  models?: Models,
): Promise<UpdateArticleSourceResult | undefined> {
  const { media: sourceMedia, ...sourceFields } = source;
  // Captured inside the transaction and used after it commits so we
  // can enqueue a fresh summarization for the row whose body or
  // language just changed.
  let resummarizeTarget: ArticleContent | undefined;
  let originalContentChanged = false;
  let result: (ArticleSource & { contents: ArticleContent[] }) | undefined;
  try {
    result = await db.transaction(async (tx) => {
      const sources = await tx.update(articleSourceTable)
        .set({ ...sourceFields, updated: sql`CURRENT_TIMESTAMP` })
        .where(eq(articleSourceTable.id, id))
        .returning();
      if (sources.length < 1) return undefined;
      const originalContent = await getOriginalArticleContent(tx, sources[0]);
      if (originalContent == null) {
        if (
          sourceFields.language == null || sourceFields.title == null ||
          sourceFields.content == null
        ) {
          throw new Error("Missing required fields for new article content");
        }
        await tx.insert(articleContentTable).values({
          sourceId: id,
          language: sourceFields.language,
          title: sourceFields.title,
          content: sourceFields.content,
        });
      } else {
        const newContent = sourceFields.content ?? originalContent.content;
        const newLanguage = sourceFields.language ?? originalContent.language;
        const contentChanged = newContent !== originalContent.content;
        const languageChanged = newLanguage !== originalContent.language;
        try {
          const updatedRows = await tx.update(articleContentTable)
            .set({
              language: newLanguage,
              title: sourceFields.title ?? originalContent.title,
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
          if (
            (contentChanged || languageChanged) && updatedRows.length > 0
          ) {
            resummarizeTarget = updatedRows[0];
          }
          if (contentChanged && updatedRows.length > 0) {
            originalContentChanged = true;
          }
        } catch (error) {
          if (
            error instanceof postgres.PostgresError && error.code === "23503"
          ) {
            throw new LanguageChangeWithTranslationsError();
          }
          throw error;
        }
      }
      const contents = await tx.query.articleContentTable.findMany({
        where: { sourceId: id },
        orderBy: { published: "asc" },
      });
      if (sourceFields.content != null || sourceMedia != null) {
        const originalContent = contents.find((content) =>
          content.originalLanguage == null &&
          content.translatorId == null &&
          content.translationRequesterId == null
        );
        if (originalContent == null) {
          throw new Error("Missing original article content");
        }
        const mediaUpdated = await updateArticleSourceMedia(
          tx,
          id,
          originalContent.content,
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
  // Queue a fresh summarization outside of the transaction so the
  // claim is visible to other workers as soon as it is acquired and
  // the deferred apply step does not try to use a closed transaction.
  if (resummarizeTarget != null && models != null) {
    await startArticleContentSummary(db, models.summarizer, resummarizeTarget);
  }
  return { source: result, originalContentChanged };
}

export async function updateArticle(
  fedCtx: Context<ContextData>,
  articleSourceId: Uuid,
  source: Partial<NewArticleSource> & {
    title?: string;
    content?: string;
    language?: string;
    media?: readonly ArticleMediumInput[];
  },
): Promise<
  Post & {
    actor: Actor & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
      instance: Instance;
    };
    articleSource: ArticleSource & {
      account: Account & { emails: AccountEmail[]; links: AccountLink[] };
    };
  } | undefined
> {
  const { db, models } = fedCtx.data;
  const previousPost = await db.query.postTable.findFirst({
    where: { articleSourceId },
  });
  const updateResult = await updateArticleSource(
    db,
    articleSourceId,
    source,
    models,
  );
  if (updateResult == null) return undefined;
  const { source: articleSource, originalContentChanged } = updateResult;
  const account = await db.query.accountTable.findFirst({
    where: { id: articleSource.accountId },
    with: { avatarMedium: true, emails: true, links: true },
  });
  if (account == null) return undefined;
  const post = await syncPostFromArticleSource(fedCtx, {
    ...articleSource,
    account,
  });
  const articleObject = await getArticle(fedCtx, { ...articleSource, account });
  const activity = new vocab.Update({
    id: new URL(
      `#update/${articleSource.updated.toISOString()}`,
      articleObject.id ?? fedCtx.canonicalOrigin,
    ),
    actors: articleObject.attributionIds,
    tos: articleObject.toIds,
    ccs: articleObject.ccIds,
    object: articleObject,
  });
  await fedCtx.sendActivity(
    { identifier: articleSource.accountId },
    "followers",
    activity,
    {
      orderingKey: post.iri,
      preferSharedInbox: true,
      excludeBaseUris: [
        new URL(fedCtx.origin),
        new URL(fedCtx.canonicalOrigin),
      ],
    },
  );
  const relayedTags = await sendTagsPubRelayActivity(
    fedCtx,
    articleSource.accountId,
    activity,
    {
      orderingKey: post.iri,
      visibility: post.visibility,
      accountBio: account.bio,
      relayedTags: previousPost?.relayedTags,
    },
  );
  if (relayedTags != null) {
    await db.update(postTable)
      .set({ relayedTags: [...relayedTags] })
      .where(eq(postTable.id, post.id));
    post.relayedTags = [...relayedTags];
  }
  // TODO: send Update(Article) to the mentioned actors too
  // After federating the original-language Update, invalidate any
  // existing translation rows so they retranslate against the new
  // body.  Each restarted translation will fire its own Update on
  // completion (correct ActivityPub semantics — peers see the
  // original change first, then each translation's refresh as it
  // becomes available).  We `await` the synchronous claim-and-reset
  // step so the placeholders are visible by the time this function
  // returns; the actual `translate()` calls run in the background.
  //
  // Gate on the article-level `allowLlmTranslation` switch so an
  // edit that turns LLM translation off in the same update does
  // not still enqueue background `translate()` runs against the
  // author's just-expressed wish.  Existing translation rows from
  // before the switch was flipped are left alone (stale, not
  // refreshed); re-enabling the switch and editing the body again
  // brings them back into sync.
  if (originalContentChanged && articleSource.allowLlmTranslation) {
    await restartArticleContentTranslations(fedCtx, articleSource);
  }
  return post;
}

export function getOriginalArticleContent(
  source: ArticleSource & { contents: ArticleContent[] },
): ArticleContent | undefined;
export function getOriginalArticleContent(
  db: Database,
  source: ArticleSource,
): Promise<ArticleContent | undefined>;
export function getOriginalArticleContent(
  dbOrSrc: ArticleSource & { contents: ArticleContent[] } | Database,
  source?: ArticleSource,
): ArticleContent | undefined | Promise<ArticleContent | undefined> {
  if ("contents" in dbOrSrc) {
    const contents = dbOrSrc.contents.filter((content) =>
      content.originalLanguage == null &&
      content.translatorId == null &&
      content.translationRequesterId == null
    );
    return minBy(contents, (content) => +content.published);
  }
  if (source == null) return Promise.resolve(undefined);
  return dbOrSrc.query.articleContentTable.findFirst({
    where: {
      sourceId: source.id,
      originalLanguage: { isNull: true },
      translatorId: { isNull: true },
      translationRequesterId: { isNull: true },
    },
    orderBy: { published: "asc" },
  });
}

export async function startArticleContentSummary(
  db: Database,
  model: LanguageModel,
  content: ArticleContent,
): Promise<void> {
  // Use a JS-side Date so the value round-trips through the driver
  // with millisecond precision.  This is later used as a CAS stamp.
  const claim = new Date();
  const updated = await db.update(articleContentTable)
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
  summarize({
    model,
    sourceLanguage: claimed.beingTranslated
      ? claimed.originalLanguage ?? claimed.language
      : claimed.language,
    targetLanguage: claimed.language,
    text: claimed.content,
  }).then(async (summary) => {
    await applyArticleContentSummary(db, claimed, summary, claim);
  }).catch(async (error) => {
    logger.error("Summary failed ({sourceId} {language}): {error}", {
      ...claimed,
      error,
    });
    await db.update(articleContentTable)
      .set({ summaryStarted: null })
      .where(
        and(
          eq(articleContentTable.sourceId, claimed.sourceId),
          eq(articleContentTable.language, claimed.language),
          eq(articleContentTable.summaryStarted, claim),
        ),
      );
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
    const claimWhere = claim == null ? undefined : eq(
      articleContentTable.summaryStarted,
      claim,
    );
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
      const updated = await tx.update(articleContentTable)
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
      if (content.originalLanguage == null) {
        await tx.update(postTable)
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
    const updated = await tx.update(articleContentTable)
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
    if (content.originalLanguage == null) {
      await tx.update(postTable)
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
  fedCtx: Context<ContextData>,
  { content, targetLanguage, requester }: ArticleContentTranslationOptions,
): Promise<ArticleContent> {
  const { db } = fedCtx.data;
  // Stamp `updated` with a JS-side Date rather than letting it
  // default to PG's `CURRENT_TIMESTAMP`.  See the long comment on
  // the CAS in `runArticleContentTranslation` for why this matters:
  // the helper's claim WHERE compares the row's stored `updated`
  // against `queued.updated`, and the comparison is only reliable
  // when both sides round-trip through the same precision (the
  // `postgres` driver hands JS `Date` values back at ms precision
  // while `timestamptz` keeps µs).
  const queueStamp = new Date();
  const inserted = await db.insert(articleContentTable).values({
    sourceId: content.sourceId,
    language: targetLanguage,
    title: content.title,
    content: content.content,
    originalLanguage: content.language,
    translationRequesterId: requester.id,
    beingTranslated: true,
    updated: queueStamp,
  }).onConflictDoNothing().returning();
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
    const reclaimed = await db.update(articleContentTable)
      .set({
        updated: reclaim,
        title: content.title,
        content: content.content,
        originalLanguage: content.language,
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
 * No-ops when the article has no original-language content (e.g.,
 * remote articles with no `articleSource.contents` row in the
 * article's own language) or no translation rows at all.
 *
 * Used by {@link updateArticle} to satisfy
 * <https://github.com/hackers-pub/hackerspub/issues/95>.
 */
export async function restartArticleContentTranslations(
  fedCtx: Context<ContextData>,
  articleSource: ArticleSource,
): Promise<void> {
  const { db } = fedCtx.data;
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
    await tx.select({ id: articleSourceTable.id })
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
    const reset = await tx.update(articleContentTable)
      .set({
        title: original.title,
        content: original.content,
        beingTranslated: true,
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
          // Only LLM-requested translations.  Human translations
          // carry `translatorId` instead of `translationRequesterId`
          // (the schema check
          // `article_content_translator_translation_requester_id_check`
          // makes the two columns mutually exclusive), and resetting
          // a curated human translation back to a source-language
          // placeholder so the LLM can re-do it would silently
          // destroy that contributor's work and mis-attribute the
          // result.
          isNull(articleContentTable.translatorId),
        ),
      )
      .returning();
    if (reset.length > 0) {
      logger.debug(
        "Restarted {count} translation(s) for {sourceId}.",
        { count: reset.length, sourceId: articleSource.id },
      );
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
    runArticleContentTranslation(fedCtx, resetRow).catch((error) => {
      logger.error(
        "Failed to start retranslation for {sourceId} {language}: {error}",
        {
          sourceId: resetRow.sourceId,
          language: resetRow.language,
          error,
        },
      );
    });
  }
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
export function splitTranslationTitleAndContent(
  translation: string,
): { title: string; content: string } {
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
  fedCtx: Context<ContextData>,
  queued: ArticleContent,
): Promise<void> {
  const { db, models: { translator: model, summarizer } } = fedCtx.data;
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
  const claimedRows = await db.update(articleContentTable)
    .set({ updated: claim })
    .where(
      and(
        eq(articleContentTable.sourceId, sourceId),
        eq(articleContentTable.language, targetLanguage),
        eq(articleContentTable.beingTranslated, true),
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
  translate({
    model,
    summarizationModel: summarizer,
    sourceLanguage: claimed.originalLanguage!,
    targetLanguage,
    text,
    // Pass context for better translation quality.
    authorName: articleSource?.account?.actor?.name ?? undefined,
    authorBio: articleSource?.account?.actor?.bioHtml ?? undefined,
    tags: articleSource?.tags,
  }).then(async (translation) => {
    logger.debug("Translation completed: {sourceId} {language}", {
      ...queued,
      translation,
    });
    const { title, content } = splitTranslationTitleAndContent(translation);
    const updated = await db.update(articleContentTable)
      .set({
        title,
        content,
        beingTranslated: false,
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
    const article = await db.query.articleSourceTable.findFirst({
      where: { id: sourceId },
      with: {
        account: true,
        contents: true,
      },
    });
    if (article == null) return;
    const post = await db.query.postTable.findFirst({
      where: { articleSourceId: article.id },
    });
    const articleObject = await getArticle(fedCtx, article);
    // The id has to be unique across translation completions for
    // this article — multiple locales can complete in close
    // succession (especially after a body edit re-queues every
    // existing translation), and they would all collide on
    // `article.updated` since translation completions don't bump
    // it.  Including both the target language and the translated
    // row's own `updated` (a fresh `CURRENT_TIMESTAMP` from the
    // success UPDATE just above) keeps the id distinct from the
    // original-language Update activity and from every other
    // translation's Update for the same edit.
    const update = new vocab.Update({
      id: new URL(
        `#update/${updated[0].updated.toISOString()}/${targetLanguage}`,
        articleObject.id ?? fedCtx.canonicalOrigin,
      ),
      actors: articleObject.attributionIds,
      tos: articleObject.toIds,
      ccs: articleObject.ccIds,
      object: articleObject,
    });
    const orderingKey = fedCtx.getObjectUri(vocab.Article, { id: article.id })
      .href;
    await fedCtx.sendActivity(
      { identifier: article.accountId },
      "followers",
      update,
      {
        orderingKey,
        preferSharedInbox: true,
        excludeBaseUris: [
          new URL(fedCtx.origin),
          new URL(fedCtx.canonicalOrigin),
        ],
      },
    );
    if (post != null) {
      const relayedTags = await sendTagsPubRelayActivity(
        fedCtx,
        article.accountId,
        update,
        {
          orderingKey,
          visibility: post.visibility,
          accountBio: article.account.bio,
          relayedTags: post.relayedTags,
        },
      );
      if (relayedTags != null) {
        await db.update(postTable)
          .set({ relayedTags: [...relayedTags] })
          .where(eq(postTable.id, post.id));
      }
    }
    // TODO: send Update(Article) to the mentioned actors too
    await startArticleContentSummary(
      db,
      summarizer,
      updated[0],
    );
  }).catch(async (error) => {
    logger.error("Translation failed ({sourceId} {language}): {error}", {
      ...queued,
      error,
    });
    await db.delete(articleContentTable)
      .where(
        and(
          eq(articleContentTable.sourceId, sourceId),
          eq(articleContentTable.language, targetLanguage),
          // CAS on the same claim as the success path — a stale
          // failure must not delete a row another caller has since
          // re-claimed.
          eq(articleContentTable.updated, claim),
        ),
      );
  });
}
