import assert from "node:assert";
import test from "node:test";
import {
  createArticle,
  promoteArticleTranslationDrafts,
  publishArticleTranslation,
  saveArticleDraft,
  startArticleContentTranslation,
  updateArticleSource,
} from "./article.ts";
import { saveArticleTranslationDraft } from "./article-translation.ts";
import { getDraftRevision } from "./article-revision.ts";
import {
  articleContentTable,
  articleDraftMediumTable,
  articleSourceMediumTable,
  articleSourceTable,
  mediumTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";

const fakeModels = {
  summarizer: {} as never,
  translator: {} as never,
  moderationAnalyzer: {} as never,
};

test("saveArticleTranslationDraft() defaults the author credit, captures a baseline, and never duplicates a language", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "translationauthor",
      name: "Translation Author",
      email: "translationauthor@example.com",
    });
    const draft = await saveArticleDraft(tx, author.account, {
      title: "Original title",
      content: "Original body",
      language: "en",
      tags: [],
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;

    const created = await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "ko",
      title: "Translated title",
      content: "Translated body",
    });
    assert.equal(created.status, "ok");
    if (created.status !== "ok") return;
    assert.equal(created.draft.translatorId, author.account.id);
    assert.equal(created.draft.provenance, "human");
    assert.equal(created.draft.revision, 1);
    assert.ok(created.draft.sourceRevisionId != null);

    // The baseline points at the original's current revision.
    const revision = await getDraftRevision(tx, draft.draft.id);
    assert.equal(revision?.id, created.draft.sourceRevisionId);

    // A second create for the same language returns the existing draft
    // unchanged instead of overwriting it.
    const duplicate = await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "ko",
      title: "Should be ignored",
      content: "Should be ignored",
    });
    assert.equal(duplicate.status, "ok");
    if (duplicate.status !== "ok") return;
    assert.equal(duplicate.draft.id, created.draft.id);
    assert.equal(duplicate.draft.title, "Translated title");

    // A stale revision is reported as a conflict.
    const conflict = await saveArticleTranslationDraft(tx, author.account, {
      id: created.draft.id,
      language: "ko",
      title: "Edited",
      content: "Edited",
      revision: created.draft.revision + 1,
    });
    assert.equal(conflict.status, "conflict");

    // The original's own language and unsupported tags are rejected.
    const sameLanguage = await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "en",
      title: "Same",
      content: "Same",
    });
    assert.deepEqual(sameLanguage, {
      status: "invalid",
      inputPath: "language",
    });
    const unsupported = await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "not a locale",
      title: "x",
      content: "x",
    });
    assert.deepEqual(unsupported, {
      status: "invalid",
      inputPath: "language",
    });
  });
});

test("saveArticleDraft() rejects an original-language change once translations exist", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "languageguard",
      name: "Language Guard",
      email: "languageguard@example.com",
    });
    const draft = await saveArticleDraft(tx, author.account, {
      title: "Original",
      content: "Body",
      language: "en",
      tags: [],
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;

    await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "ko",
      title: "번역",
      content: "본문",
    });

    const result = await saveArticleDraft(tx, author.account, {
      id: draft.draft.id,
      revision: draft.draft.revision,
      title: "Original",
      content: "Body",
      language: "fr",
      tags: [],
    });
    assert.deepEqual(result, { status: "invalid", inputPath: "language" });
  });
});

test("promoteArticleTranslationDrafts() re-points selected and unselected drafts to the new source", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "promoteauthor",
      name: "Promote Author",
      email: "promoteauthor@example.com",
    });
    const draft = await saveArticleDraft(tx, author.account, {
      title: "Original",
      content: "Body",
      language: "en",
      tags: [],
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    const selected = await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "ko",
      title: "Selected",
      content: "Selected body",
    });
    const unselected = await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "ja",
      title: "Unselected",
      content: "Unselected body",
    });
    assert.equal(selected.status, "ok");
    assert.equal(unselected.status, "ok");
    if (selected.status !== "ok" || unselected.status !== "ok") return;

    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "promoted-source",
      tags: [],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    await promoteArticleTranslationDrafts(tx, draft.draft.id, sourceId, [
      { id: selected.draft.id, revision: selected.draft.revision },
    ]);
    for (const id of [selected.draft.id, unselected.draft.id]) {
      const row = await tx.query.articleTranslationDraftTable.findFirst({
        where: { id },
      });
      assert.equal(row?.sourceId, sourceId);
      assert.equal(row?.articleDraftId, null);
    }
    const selectedRow = await tx.query.articleTranslationDraftTable.findFirst({
      where: { id: selected.draft.id },
    });
    assert.equal(selectedRow?.publishedRevision, selected.draft.revision);
    // The baseline revision moved with the draft to the source.
    const revision = await tx.query.articleSourceRevisionTable.findFirst({
      where: { sourceId },
    });
    assert.ok(revision != null);
  });
});

test("publishArticleTranslation() publishes a human draft without touching the original", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "publishtranslation",
      name: "Publish Translation",
      email: "publishtranslation@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "publish-translation",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;

    const draft = await saveArticleTranslationDraft(tx, author.account, {
      sourceId,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;

    const result = await publishArticleTranslation(fedCtx, author.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.sourceId, sourceId);
    assert.equal(result.language, "ko");

    const ko = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.equal(ko?.title, "한국어 제목");
    assert.equal(ko?.provenance, "human");
    assert.equal(ko?.translatorId, author.account.id);
    assert.equal(ko?.beingTranslated, false);

    // The original content is untouched, and the draft records the published
    // revision.
    const en = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.equal(en?.title, "Original title");
    const storedDraft = await tx.query.articleTranslationDraftTable.findFirst({
      where: { id: draft.draft.id },
    });
    assert.equal(storedDraft?.publishedRevision, draft.draft.revision);
  });
});

test("startArticleContentTranslation() never reclaims a human translation row", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "humanprotection",
      name: "Human Protection",
      email: "humanprotection@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "human-protection",
      tags: [],
      allowLlmTranslation: true,
      title: "Original",
      content: "Body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "Human title",
      content: "Human body",
      originalLanguage: "en",
      translatorId: author.account.id,
      provenance: "human",
      beingTranslated: false,
    });
    const original = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.ok(original != null);

    const result = await startArticleContentTranslation(fedCtx, {
      content: original,
      targetLanguage: "ko",
      requester: author.account,
    });
    assert.equal(result.title, "Human title");
    assert.equal(result.provenance, "human");
    assert.equal(result.beingTranslated, false);
  });
});

test("article_draft revisions are created for the original and reused on no-op saves", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "revisionauthor",
      name: "Revision Author",
      email: "revisionauthor@example.com",
    });
    const draft = await saveArticleDraft(tx, author.account, {
      title: "Title",
      content: "Body",
      language: "en",
      tags: [],
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    const first = await getDraftRevision(tx, draft.draft.id);
    assert.ok(first != null);

    const second = await saveArticleDraft(tx, author.account, {
      id: draft.draft.id,
      revision: draft.draft.revision,
      title: "Title",
      content: "Body",
      language: "en",
      tags: [],
    });
    assert.equal(second.status, "ok");
    const reuse = await getDraftRevision(tx, draft.draft.id);
    assert.equal(reuse?.id, first?.id);

    const third = await saveArticleDraft(tx, author.account, {
      id: draft.draft.id,
      revision: second.status === "ok" ? second.draft.revision : 2,
      title: "Title",
      content: "Changed body",
      language: "en",
      tags: [],
    });
    assert.equal(third.status, "ok");
    const changed = await getDraftRevision(tx, draft.draft.id);
    assert.notEqual(changed?.id, first?.id);
  });
});

test("createArticle() reuses a supplied draft revision so a together-published translation stays current", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "reuserevisionauthor",
      name: "Reuse Revision Author",
      email: "reuserevisionauthor@example.com",
    });
    const draft = await saveArticleDraft(tx, author.account, {
      title: "Original title",
      content: "Original body",
      language: "en",
      tags: [],
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    const baseline = await getDraftRevision(tx, draft.draft.id);
    assert.ok(baseline != null);

    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "reuse-revision",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
      originalRevisionId: baseline.id,
      additionalContents: [
        {
          language: "ko",
          title: "번역",
          content: "본문",
          originalLanguage: "en",
          translatorId: author.account.id,
          provenance: "human",
          sourceRevisionId: baseline.id,
        },
      ],
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const revisions = await tx.query.articleSourceRevisionTable.findMany({
      where: { sourceId },
    });
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].id, baseline.id);
    const original = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    const translation = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.equal(original?.sourceRevisionId, baseline.id);
    assert.equal(translation?.sourceRevisionId, baseline.id);
  });
});

test("publishArticleTranslation() replaces an in-flight automatic placeholder", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "replaceplaceholder",
      name: "Replace Placeholder",
      email: "replaceplaceholder@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "replace-placeholder",
      tags: [],
      allowLlmTranslation: true,
      title: "Original",
      content: "Body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "자동 번역",
      content: "자동 번역 본문",
      originalLanguage: "en",
      translationRequesterId: author.account.id,
      provenance: "llm",
      beingTranslated: true,
    });

    const draft = await saveArticleTranslationDraft(tx, author.account, {
      sourceId,
      language: "ko",
      title: "인간 번역",
      content: "인간 번역 본문",
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;

    const result = await publishArticleTranslation(fedCtx, author.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
    });
    assert.equal(result.status, "ok");
    const ko = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.equal(ko?.title, "인간 번역");
    assert.equal(ko?.provenance, "human");
    assert.equal(ko?.beingTranslated, false);
    assert.equal(ko?.translationRequesterId, null);
  });
});

test("promoteArticleTranslationDrafts() inherits parent attachments into surviving drafts", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "inheritmedia",
      name: "Inherit Media",
      email: "inheritmedia@example.com",
    });
    const draft = await saveArticleDraft(tx, author.account, {
      title: "Original",
      content: "Body",
      language: "en",
      tags: [],
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    const [medium] = await tx
      .insert(mediumTable)
      .values({
        id: generateUuidV7(),
        key: "inherited-image",
        type: "image/webp",
      })
      .returning();
    await tx.insert(articleDraftMediumTable).values({
      articleDraftId: draft.draft.id,
      key: "shared-key",
      mediumId: medium.id,
    });
    const translation = await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "ko",
      title: "번역",
      content: "본문 ![img](hp-medium:shared-key)",
    });
    assert.equal(translation.status, "ok");
    if (translation.status !== "ok") return;

    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "inherit-media",
      tags: [],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    await promoteArticleTranslationDrafts(tx, draft.draft.id, sourceId, []);

    const inherited =
      await tx.query.articleTranslationDraftMediumTable.findFirst({
        where: { articleTranslationDraftId: translation.draft.id },
      });
    assert.equal(inherited?.key, "shared-key");
    assert.equal(inherited?.mediumId, medium.id);
  });
});

test("updateArticleSource() retains media referenced only by a private translation draft", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "draftmediaretain",
      name: "Draft Media Retain",
      email: "draftmediaretain@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");
    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "draft-media-retain",
      tags: [],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "en",
      title: "Original",
      content: "Body",
      published,
      updated: published,
    });
    const [medium] = await tx
      .insert(mediumTable)
      .values({
        id: generateUuidV7(),
        key: "survives",
        type: "image/webp",
      })
      .returning();
    await tx.insert(articleSourceMediumTable).values({
      articleSourceId: sourceId,
      key: "survives",
      mediumId: medium.id,
    });

    const draft = await saveArticleTranslationDraft(tx, author.account, {
      sourceId,
      language: "ko",
      title: "번역",
      content: "![x](hp-medium:survives)",
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;

    // Dropping the image from the original must not prune the mapping the
    // private draft still resolves through.
    const updated = await updateArticleSource(tx, sourceId, {
      content: "New body without the image.",
    });
    assert.ok(updated != null);
    const mapping = await tx.query.articleSourceMediumTable.findFirst({
      where: { articleSourceId: sourceId, key: "survives" },
    });
    assert.ok(mapping != null);

    // A stray, unknown key in the draft must not block later original edits.
    const withStray = await saveArticleTranslationDraft(tx, author.account, {
      id: draft.draft.id,
      revision: draft.draft.revision,
      language: "ko",
      title: "번역",
      content: "![x](hp-medium:unknown-key)",
    });
    assert.equal(withStray.status, "ok");
    const again = await updateArticleSource(tx, sourceId, {
      content: "Another body.",
    });
    assert.ok(again != null);
  });
});
