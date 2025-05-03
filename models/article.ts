import type { Context } from "@fedify/fedify";
import * as vocab from "@fedify/fedify/vocab";
import { summarize } from "@hackerspub/ai/summary";
import { translate } from "@hackerspub/ai/translate";
import { getLogger } from "@logtape/logtape";
import { minBy } from "@std/collections/min-by";
import type { LanguageModelV1 } from "ai";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getArticle } from "../federation/objects.ts";
import type { ContextData, Models } from "./context.ts";
import type { Database } from "./db.ts";
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
  articleSourceTable,
  type Blocking,
  type Following,
  type Instance,
  type Mention,
  type NewArticleDraft,
  type NewArticleSource,
  type Post,
  type Reaction,
} from "./schema.ts";
import { addPostToTimeline } from "./timeline.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";

const logger = getLogger(["hackerspub", "models", "article"]);

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
        with: { emails: true, links: true },
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
  const articleSource = await createArticleSource(
    db,
    fedCtx.data.models,
    source,
  );
  if (articleSource == null) return undefined;
  const account = await db.query.accountTable.findFirst({
    where: { id: source.accountId },
    with: { emails: true, links: true },
  });
  if (account == undefined) return undefined;
  const post = await syncPostFromArticleSource(fedCtx, {
    ...articleSource,
    account,
  });
  await addPostToTimeline(db, post);
  const articleObject = await getArticle(fedCtx, { ...articleSource, account });
  await fedCtx.sendActivity(
    { identifier: source.accountId },
    "followers",
    new vocab.Create({
      id: new URL("#create", articleObject.id ?? fedCtx.origin),
      actors: articleObject.attributionIds,
      tos: articleObject.toIds,
      ccs: articleObject.ccIds,
      object: articleObject,
    }),
    { preferSharedInbox: true, excludeBaseUris: [new URL(fedCtx.origin)] },
  );
  // TODO: send Create(Article) to the mentioned actors too
  return post;
}

export async function updateArticleSource(
  db: Database,
  id: Uuid,
  source: Partial<NewArticleSource> & {
    title?: string;
    content?: string;
    language?: string;
  },
): Promise<ArticleSource & { contents: ArticleContent[] } | undefined> {
  const sources = await db.update(articleSourceTable)
    .set({ ...source, updated: sql`CURRENT_TIMESTAMP` })
    .where(eq(articleSourceTable.id, id))
    .returning();
  if (sources.length < 1) return undefined;
  const originalContent = await getOriginalArticleContent(db, sources[0]);
  if (originalContent == null) {
    if (
      source.language == null || source.title == null || source.content == null
    ) {
      return undefined;
    }
    await db.insert(articleContentTable).values({
      sourceId: id,
      language: source.language,
      title: source.title,
      content: source.content,
    });
  } else {
    await db.update(articleContentTable)
      .set({
        language: source.language ?? originalContent.language,
        title: source.title ?? originalContent.title,
        content: source.content ?? originalContent.content,
        updated: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(articleContentTable.sourceId, id),
          eq(articleContentTable.language, originalContent.language),
        ),
      );
  }
  const contents = await db.query.articleContentTable.findMany({
    where: { sourceId: id },
    orderBy: { published: "asc" },
  });
  return { ...sources[0], contents };
}

export async function updateArticle(
  fedCtx: Context<ContextData>,
  articleSourceId: Uuid,
  source: Partial<NewArticleSource> & {
    title?: string;
    content?: string;
    language?: string;
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
  const { db } = fedCtx.data;
  const articleSource = await updateArticleSource(db, articleSourceId, source);
  if (articleSource == null) return undefined;
  const account = await db.query.accountTable.findFirst({
    where: { id: articleSource.accountId },
    with: { emails: true, links: true },
  });
  if (account == null) return undefined;
  const post = await syncPostFromArticleSource(fedCtx, {
    ...articleSource,
    account,
  });
  const articleObject = await getArticle(fedCtx, { ...articleSource, account });
  await fedCtx.sendActivity(
    { identifier: articleSource.accountId },
    "followers",
    new vocab.Update({
      id: new URL(
        `#update/${articleSource.updated.toISOString()}`,
        articleObject.id ?? fedCtx.canonicalOrigin,
      ),
      actors: articleObject.attributionIds,
      tos: articleObject.toIds,
      ccs: articleObject.ccIds,
      object: articleObject,
    }),
    {
      preferSharedInbox: true,
      excludeBaseUris: [
        new URL(fedCtx.origin),
        new URL(fedCtx.canonicalOrigin),
      ],
    },
  );
  // TODO: send Update(Article) to the mentioned actors too
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
  model: LanguageModelV1,
  content: ArticleContent,
): Promise<void> {
  const updated = await db.update(articleContentTable)
    .set({ summaryStarted: sql`CURRENT_TIMESTAMP` })
    .where(
      and(
        eq(articleContentTable.sourceId, content.sourceId),
        eq(articleContentTable.language, content.language),
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
  logger.debug("Starting summary for content: {sourceId} {language}", content);
  summarize({
    model,
    sourceLanguage: content.beingTranslated
      ? content.originalLanguage ?? content.language
      : content.language,
    targetLanguage: content.language,
    text: content.content,
  }).then((summary) =>
    db.update(articleContentTable)
      .set({ summary })
      .where(
        and(
          eq(articleContentTable.sourceId, content.sourceId),
          eq(articleContentTable.language, content.language),
        ),
      )
  ).catch(() => {
    logger.error("Summary failed: {sourceId} {language}", content);
    db.update(articleContentTable)
      .set({ summaryStarted: null })
      .where(
        and(
          eq(articleContentTable.sourceId, content.sourceId),
          eq(articleContentTable.language, content.language),
        ),
      );
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
  const { db, models: { translator: model } } = fedCtx.data;
  const inserted = await db.insert(articleContentTable).values({
    sourceId: content.sourceId,
    language: targetLanguage,
    title: content.title,
    content: content.content,
    originalLanguage: content.language,
    translationRequesterId: requester.id,
    beingTranslated: true,
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
    queued = translated;
  } else {
    queued = inserted[0];
  }
  logger.debug(
    "Starting translation for content: {sourceId} {language}",
    queued,
  );
  // Combine title and content for translation
  const text = `# ${content.title}\n\n${content.content}`;
  translate({
    model,
    sourceLanguage: content.language,
    targetLanguage,
    text,
  }).then(async (translation) => {
    logger.debug("Translation completed: {sourceId} {language}", {
      ...queued,
      translation,
    });
    // Split the translation into title and content
    const title = translation.match(/^\s*#\s+([^\n]*)/)?.[1] ?? "";
    const content = translation.replace(/^\s*#\s+[^\n]*\s*/, "").trim();
    const updated = await db.update(articleContentTable)
      .set({
        title,
        content,
        beingTranslated: false,
        updated: sql`CURRENT_TIMESTAMP`,
      })
      .where(
        and(
          eq(articleContentTable.sourceId, queued.sourceId),
          eq(articleContentTable.language, targetLanguage),
        ),
      )
      .returning();
    if (updated.length < 1) return;
    const article = await db.query.articleSourceTable.findFirst({
      where: { id: queued.sourceId },
      with: {
        account: true,
        contents: true,
      },
    });
    if (article == null) return;
    const articleObject = await getArticle(fedCtx, article);
    const update = new vocab.Update({
      id: new URL(
        `#update/${article.updated.toISOString()}`,
        articleObject.id ?? fedCtx.canonicalOrigin,
      ),
      actors: articleObject.attributionIds,
      tos: articleObject.toIds,
      ccs: articleObject.ccIds,
      object: articleObject,
    });
    await fedCtx.sendActivity(
      { identifier: article.accountId },
      "followers",
      update,
      {
        preferSharedInbox: true,
        excludeBaseUris: [
          new URL(fedCtx.origin),
          new URL(fedCtx.canonicalOrigin),
        ],
      },
    );
    // TODO: send Update(Article) to the mentioned actors too
    await startArticleContentSummary(
      db,
      model,
      updated[0],
    );
  }).catch(() => {
    logger.error("Translation failed: {sourceId} {language}", queued);
    db.delete(articleContentTable)
      .where(
        and(
          eq(articleContentTable.sourceId, queued.sourceId),
          eq(articleContentTable.language, targetLanguage),
        ),
      );
  });
  return queued;
}
