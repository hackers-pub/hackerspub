import assert from "node:assert";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  createArticle,
  publishArticleTranslation,
  saveArticleDraft,
  restartArticleContentTranslations,
  startArticleContentTranslation,
  updateArticle,
  updateArticleSource,
} from "./article.ts";
import {
  getCurrentDraftRevision,
  getCurrentSourceRevision,
  getSourceRevision,
} from "./article-revision.ts";
import {
  acknowledgeArticleTranslationSource,
  getReviewState,
  getTranslationReviewStates,
} from "./article-translation-review.ts";
import {
  deleteArticleTranslationDraft,
  saveArticleTranslationDraft,
} from "./article-translation.ts";
import {
  articleContentTable,
  articleSourceRevisionTable,
  notificationTable,
  organizationMembershipTable,
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

test("getReviewState() separates an unknown baseline from a known source change", () => {
  const a = generateUuidV7();
  const b = generateUuidV7();
  assert.equal(getReviewState(a, a), "current");
  assert.equal(getReviewState(a, b), "needsReview");
  assert.equal(getReviewState(null, a), "unknownBaseline");
  assert.equal(getReviewState(a, undefined), "unknownBaseline");
  // Reverting the original to text a translation was once reviewed against
  // still produces a new revision, and the translation still needs review:
  // an acknowledgement speaks only for the revision it named.
  assert.notEqual(getReviewState(a, b), "current");
});

test("a title-only edit invalidates translations but a metadata-only edit does not", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "titleeditauthor",
      name: "Title Edit Author",
      email: "titleeditauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "title-only-edit",
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
    const published = await publishArticleTranslation(fedCtx, author.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
    });
    assert.equal(published.status, "ok");

    const before = await getTranslationReviewStates(tx, { sourceId });
    assert.equal(before.contents.get("ko"), "current");

    // Tags alone create no revision, so nothing becomes stale.
    const metadataOnly = await updateArticleSource(tx, sourceId, {
      tags: ["tag"],
    });
    assert.equal(metadataOnly?.sourceRevision, undefined);
    const afterMetadata = await getTranslationReviewStates(tx, { sourceId });
    assert.equal(afterMetadata.contents.get("ko"), "current");

    // Re-saving identical text creates no revision either.
    const noop = await updateArticleSource(tx, sourceId, {
      title: "Original title",
      content: "Original body",
    });
    assert.equal(noop?.sourceRevision, undefined);
    assert.equal(
      (await getTranslationReviewStates(tx, { sourceId })).contents.get("ko"),
      "current",
    );

    // A title-only change does, even though the body is untouched.
    const titleOnly = await updateArticleSource(tx, sourceId, {
      title: "New title",
    });
    assert.ok(titleOnly?.sourceRevision != null);
    assert.equal(titleOnly?.originalContentChanged, false);
    const afterTitle = await getTranslationReviewStates(tx, { sourceId });
    assert.equal(afterTitle.contents.get("ko"), "needsReview");
  });
});

test("a draft-only edit changes neither public freshness nor notifications", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "draftonlyeditauthor",
      name: "Draft Only Edit Author",
      email: "draftonlyeditauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "draft-only-edit",
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
    await publishArticleTranslation(fedCtx, author.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
    });

    // Saving the private translation draft is not a source change.
    const saved = await saveArticleTranslationDraft(tx, author.account, {
      id: draft.draft.id,
      sourceId,
      language: "ko",
      title: "한국어 제목 2",
      content: "한국어 본문 2",
      revision: draft.draft.revision,
    });
    assert.equal(saved.status, "ok");
    const states = await getTranslationReviewStates(tx, { sourceId });
    assert.equal(states.contents.get("ko"), "current");
    const notifications = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(notifications.length, 0);
  });
});

test("a source edit notifies the credited translator once and coalesces repeats", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const owner = await insertAccountWithActor(tx, {
      username: "coalesceorg",
      name: "Coalesce Org",
      email: "coalesceorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const editor = await insertAccountWithActor(tx, {
      username: "coalesceeditor",
      name: "Coalesce Editor",
      email: "coalesceeditor@example.com",
    });
    const translator = await insertAccountWithActor(tx, {
      username: "coalescetranslator",
      name: "Coalesce Translator",
      email: "coalescetranslator@example.com",
    });
    for (const member of [editor, translator]) {
      await tx.insert(organizationMembershipTable).values({
        organizationAccountId: owner.account.id,
        memberAccountId: member.account.id,
        role: "member",
        invitedById: member.account.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
    }
    const article = await createArticle(fedCtx, {
      accountId: owner.account.id,
      publishedYear: 2026,
      slug: "coalesce-source-edit",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const draft = await saveArticleTranslationDraft(tx, editor.account, {
      sourceId,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
      translatorId: translator.account.id,
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    await publishArticleTranslation(fedCtx, editor.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
    });

    await updateArticle(
      fedCtx,
      sourceId,
      { title: "First edit" },
      { editor: { accountId: editor.account.id } },
    );
    const first = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(first.length, 1);
    assert.equal(first[0].accountId, translator.account.id);
    assert.deepEqual(first[0].translationLanguages, ["ko"]);
    // The actor is the owning workspace, which cannot outlive the article, so
    // the notification never disappears because an editor's account went away.
    assert.deepEqual(first[0].actorIds, [owner.actor.id]);
    // The editor is not notified about their own edit.
    assert.equal(
      first.some((row) => row.accountId === editor.account.id),
      false,
    );

    await updateArticle(
      fedCtx,
      sourceId,
      { title: "Second edit" },
      { editor: { accountId: editor.account.id } },
    );
    const second = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(second.length, 1);
    assert.equal(second[0].id, first[0].id);
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.equal(second[0].articleSourceRevisionId, current?.id);
    assert.notEqual(
      second[0].articleSourceRevisionId,
      first[0].articleSourceRevisionId,
    );
    assert.ok(second[0].created.getTime() >= first[0].created.getTime());
  });
});

test("a translator's own edit neither notifies them nor discards their outstanding notification", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const owner = await insertAccountWithActor(tx, {
      username: "selfeditorg",
      name: "Self Edit Org",
      email: "selfeditorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const editor = await insertAccountWithActor(tx, {
      username: "selfediteditor",
      name: "Self Edit Editor",
      email: "selfediteditor@example.com",
    });
    const translator = await insertAccountWithActor(tx, {
      username: "selfedittranslator",
      name: "Self Edit Translator",
      email: "selfedittranslator@example.com",
    });
    for (const member of [editor, translator]) {
      await tx.insert(organizationMembershipTable).values({
        organizationAccountId: owner.account.id,
        memberAccountId: member.account.id,
        role: "member",
        invitedById: member.account.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
    }
    const article = await createArticle(fedCtx, {
      accountId: owner.account.id,
      publishedYear: 2026,
      slug: "self-edit-suppression",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const draft = await saveArticleTranslationDraft(tx, editor.account, {
      sourceId,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
      translatorId: translator.account.id,
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    await publishArticleTranslation(fedCtx, editor.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
    });

    // Someone else's edit raises the notification.
    await updateArticle(
      fedCtx,
      sourceId,
      { title: "Edited by a colleague" },
      { editor: { accountId: editor.account.id } },
    );
    const raised = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(raised.length, 1);
    assert.equal(raised[0].accountId, translator.account.id);

    // The translator then edits the original themselves. They are not
    // notified about their own edit, but the outstanding reminder of the
    // colleague's change survives and follows the newest revision.
    await updateArticle(
      fedCtx,
      sourceId,
      { title: "Edited by the translator" },
      { editor: { accountId: translator.account.id } },
    );
    const afterSelfEdit = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(afterSelfEdit.length, 1);
    assert.equal(afterSelfEdit[0].id, raised[0].id);
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.equal(afterSelfEdit[0].articleSourceRevisionId, current?.id);
    // Their own edit must not resurface it as unread.
    assert.equal(
      afterSelfEdit[0].created.getTime(),
      raised[0].created.getTime(),
    );
  });
});

test("acknowledging the current revision clears the notification; an older one does not", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const owner = await insertAccountWithActor(tx, {
      username: "acknowledgeorg",
      name: "Acknowledge Org",
      email: "acknowledgeorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const editor = await insertAccountWithActor(tx, {
      username: "acknowledgeeditor",
      name: "Acknowledge Editor",
      email: "acknowledgeeditor@example.com",
    });
    const translator = await insertAccountWithActor(tx, {
      username: "acknowledgetranslator",
      name: "Acknowledge Translator",
      email: "acknowledgetranslator@example.com",
    });
    for (const member of [editor, translator]) {
      await tx.insert(organizationMembershipTable).values({
        organizationAccountId: owner.account.id,
        memberAccountId: member.account.id,
        role: "member",
        invitedById: member.account.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
    }
    const article = await createArticle(fedCtx, {
      accountId: owner.account.id,
      publishedYear: 2026,
      slug: "acknowledge-source",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const draft = await saveArticleTranslationDraft(tx, editor.account, {
      sourceId,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
      translatorId: translator.account.id,
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    await publishArticleTranslation(fedCtx, editor.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
    });

    const firstRevision = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(firstRevision != null);
    await updateArticle(
      fedCtx,
      sourceId,
      { title: "Edited once" },
      { editor: { accountId: editor.account.id } },
    );
    await updateArticle(
      fedCtx,
      sourceId,
      { title: "Edited twice" },
      { editor: { accountId: editor.account.id } },
    );

    // Acknowledging the revision the reviewer actually read, which is no
    // longer the current one, records exactly that and leaves the translation
    // needing review.
    const stale = await acknowledgeArticleTranslationSource(
      tx,
      translator.account,
      {
        owner: { sourceId },
        language: "ko",
        sourceRevisionId: firstRevision.id,
      },
    );
    assert.equal(stale.status, "ok");
    assert.equal(
      (await getTranslationReviewStates(tx, { sourceId })).contents.get("ko"),
      "needsReview",
    );
    const stillThere = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(stillThere.length, 1);

    // Acknowledging the current revision resolves it, and the row is removed
    // rather than left listing a language that no longer needs review.
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(current != null);
    const done = await acknowledgeArticleTranslationSource(
      tx,
      translator.account,
      {
        owner: { sourceId },
        language: "ko",
        sourceRevisionId: current.id,
        translationDraftRevision: draft.draft.revision,
      },
    );
    assert.equal(done.status, "ok");
    if (done.status !== "ok") return;
    assert.equal(done.content?.reviewerId, translator.account.id);
    assert.ok(done.content?.reviewed != null);
    // Public credit is untouched by a review.
    assert.equal(done.content?.translatorId, translator.account.id);
    assert.equal(
      (await getTranslationReviewStates(tx, { sourceId })).contents.get("ko"),
      "current",
    );
    const resolved = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(resolved.length, 0);

    // A later edit raises a genuinely new actionable notification.
    await updateArticle(
      fedCtx,
      sourceId,
      { title: "Edited again" },
      { editor: { accountId: editor.account.id } },
    );
    const raised = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(raised.length, 1);
    assert.deepEqual(raised[0].translationLanguages, ["ko"]);
  });
});

test("acknowledging a revision from another article is rejected", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "foreignrevisionauthor",
      name: "Foreign Revision Author",
      email: "foreignrevisionauthor@example.com",
    });
    const articles = [];
    for (const slug of ["foreign-a", "foreign-b"]) {
      const article = await createArticle(fedCtx, {
        accountId: author.account.id,
        publishedYear: 2026,
        slug,
        tags: [],
        allowLlmTranslation: false,
        title: `Title ${slug}`,
        content: `Body ${slug}`,
        language: "en",
      });
      assert.ok(article != null);
      articles.push(article);
    }
    const draft = await saveArticleTranslationDraft(tx, author.account, {
      sourceId: articles[0].articleSource.id,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
    });
    assert.equal(draft.status, "ok");
    const foreign = await getSourceRevision(tx, articles[1].articleSource.id);
    assert.ok(foreign != null);
    const result = await acknowledgeArticleTranslationSource(
      tx,
      author.account,
      {
        owner: { sourceId: articles[0].articleSource.id },
        language: "ko",
        sourceRevisionId: foreign.id,
      },
    );
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") return;
    assert.equal(result.inputPath, "sourceRevisionId");
  });
});

test("publishing against the reviewed revision makes the translation current", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "publishreviewedauthor",
      name: "Publish Reviewed Author",
      email: "publishreviewedauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "publish-reviewed",
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

    await updateArticle(fedCtx, sourceId, { content: "Edited body" });
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(current != null);

    // Publishing without naming a revision keeps the draft's own baseline, so
    // the translation is honestly still behind.
    const blind = await publishArticleTranslation(fedCtx, author.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
    });
    assert.equal(blind.status, "ok");
    let ko = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.notEqual(ko?.sourceRevisionId, current.id);
    assert.equal(ko?.reviewerId, null);

    // Publishing against the revision the publisher was shown records them as
    // its reviewer and marks it current.
    const reviewed = await publishArticleTranslation(fedCtx, author.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
      sourceRevisionId: current.id,
    });
    assert.equal(reviewed.status, "ok");
    ko = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.equal(ko?.sourceRevisionId, current.id);
    assert.equal(ko?.reviewerId, author.account.id);
    assert.equal(
      (await getTranslationReviewStates(tx, { sourceId })).contents.get("ko"),
      "current",
    );
  });
});

test("an automatic translation started before an edit never reads as current", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "automaticbaselineauthor",
      name: "Automatic Baseline Author",
      email: "automaticbaselineauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "automatic-baseline",
      tags: [],
      allowLlmTranslation: true,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const original = await tx.query.articleContentTable.findFirst({
      where: { sourceId, originalLanguage: { isNull: true } },
    });
    assert.ok(original != null);

    const currentBefore = await getCurrentSourceRevision(tx, sourceId);
    // A job queued against the current original stamps that revision. Assert
    // on the returned placeholder: the background translation immediately
    // rewrites or removes the stored row.
    const queued = await startArticleContentTranslation(fedCtx, {
      content: original,
      targetLanguage: "ko",
      requester: author.account,
    });
    assert.equal(queued.sourceRevisionId, currentBefore?.id);

    // A job queued from text the source has already moved past records no
    // baseline at all rather than a wrong one.
    const stale = await startArticleContentTranslation(fedCtx, {
      content: { ...original, title: "Stale title", content: "Stale body" },
      targetLanguage: "ja",
      requester: author.account,
    });
    assert.equal(stale.sourceRevisionId, null);

    // Once the original moves on, a stamped automatic row reads as needing
    // review rather than claiming freshness it does not have.
    await tx
      .delete(articleContentTable)
      .where(eq(articleContentTable.language, "ko"));
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "Automatic title",
      content: "Automatic body",
      originalLanguage: "en",
      provenance: "llm",
      translationRequesterId: author.account.id,
      sourceRevisionId: currentBefore?.id ?? null,
    });
    await updateArticleSource(tx, sourceId, { content: "Edited body" });
    assert.equal(
      (await getTranslationReviewStates(tx, { sourceId })).contents.get("ko"),
      "needsReview",
    );
  });
});

test("restarting automatic translations re-stamps the baseline they translate from", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "restartbaselineauthor",
      name: "Restart Baseline Author",
      email: "restartbaselineauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "restart-baseline",
      tags: [],
      allowLlmTranslation: true,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "Old translated title",
      content: "Old translated body",
      originalLanguage: "en",
      provenance: "llm",
      translationRequesterId: author.account.id,
    });
    await updateArticleSource(tx, sourceId, { content: "Edited body" });
    const current = await getCurrentSourceRevision(tx, sourceId);
    // Assert on the rows the reset produced: the background translation that
    // follows rewrites (or, with an unavailable model, removes) them.
    const reset = await restartArticleContentTranslations(
      fedCtx,
      article.articleSource,
    );
    const ko = reset.find((row) => row.language === "ko");
    assert.ok(ko != null);
    assert.equal(ko.sourceRevisionId, current?.id);
    assert.equal(ko.beingTranslated, true);
  });
});

test("a revoked member keeps no notification while the translation still needs review", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const owner = await insertAccountWithActor(tx, {
      username: "revokedorg",
      name: "Revoked Org",
      email: "revokedorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const editor = await insertAccountWithActor(tx, {
      username: "revokededitor",
      name: "Revoked Editor",
      email: "revokededitor@example.com",
    });
    const translator = await insertAccountWithActor(tx, {
      username: "revokedtranslator",
      name: "Revoked Translator",
      email: "revokedtranslator@example.com",
    });
    for (const member of [editor, translator]) {
      await tx.insert(organizationMembershipTable).values({
        organizationAccountId: owner.account.id,
        memberAccountId: member.account.id,
        role: "member",
        invitedById: member.account.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
    }
    const article = await createArticle(fedCtx, {
      accountId: owner.account.id,
      publishedYear: 2026,
      slug: "revoked-member",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const draft = await saveArticleTranslationDraft(tx, editor.account, {
      sourceId,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
      translatorId: translator.account.id,
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    await publishArticleTranslation(fedCtx, editor.account, {
      translationDraftId: draft.draft.id,
      revision: draft.draft.revision,
    });

    // Revoke access before the edit: the former member is not notified, but
    // the translation still needs review and keeps its credit.
    await tx
      .delete(organizationMembershipTable)
      .where(
        eq(organizationMembershipTable.memberAccountId, translator.account.id),
      );
    await updateArticle(
      fedCtx,
      sourceId,
      { title: "Edited after revocation" },
      { editor: { accountId: editor.account.id } },
    );
    const notifications = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(notifications.length, 0);
    const states = await getTranslationReviewStates(tx, { sourceId });
    assert.equal(states.contents.get("ko"), "needsReview");
    const ko = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.equal(ko?.translatorId, translator.account.id);
  });
});

test("deleting a translation draft drops its language from the outstanding notification", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const owner = await insertAccountWithActor(tx, {
      username: "dropdraftorg",
      name: "Drop Draft Org",
      email: "dropdraftorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const editor = await insertAccountWithActor(tx, {
      username: "dropdrafteditor",
      name: "Drop Draft Editor",
      email: "dropdrafteditor@example.com",
    });
    const translator = await insertAccountWithActor(tx, {
      username: "dropdrafttranslator",
      name: "Drop Draft Translator",
      email: "dropdrafttranslator@example.com",
    });
    for (const member of [editor, translator]) {
      await tx.insert(organizationMembershipTable).values({
        organizationAccountId: owner.account.id,
        memberAccountId: member.account.id,
        role: "member",
        invitedById: member.account.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
    }
    const article = await createArticle(fedCtx, {
      accountId: owner.account.id,
      publishedYear: 2026,
      slug: "drop-draft-language",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const draft = await saveArticleTranslationDraft(tx, editor.account, {
      sourceId,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
      translatorId: translator.account.id,
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;

    await updateArticle(
      fedCtx,
      sourceId,
      { title: "Edited title" },
      { editor: { accountId: editor.account.id } },
    );
    const before = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(before.length, 1);
    assert.deepEqual(before[0].translationLanguages, ["ko"]);

    const deleted = await deleteArticleTranslationDraft(tx, editor.account, {
      id: draft.draft.id,
    });
    assert.equal(deleted.status, "ok");
    const after = await tx
      .select()
      .from(notificationTable)
      .where(eq(notificationTable.type, "article_translation_source_changed"));
    assert.equal(after.length, 0);
  });
});

test("a legacy translation without a baseline stays unknown across an edit", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "unknownbaselineauthor",
      name: "Unknown Baseline Author",
      email: "unknownbaselineauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "unknown-baseline",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "Legacy translated title",
      content: "Legacy translated body",
      originalLanguage: "en",
      provenance: "unknown",
      translatorId: author.account.id,
      sourceRevisionId: null,
    });
    assert.equal(
      (await getTranslationReviewStates(tx, { sourceId })).contents.get("ko"),
      "unknownBaseline",
    );
    await updateArticleSource(tx, sourceId, { title: "Edited title" });
    // An edit does not turn unverifiable freshness into a known source change.
    assert.equal(
      (await getTranslationReviewStates(tx, { sourceId })).contents.get("ko"),
      "unknownBaseline",
    );
    // An authorized review establishes a baseline from there on.
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(current != null);
    const acknowledged = await acknowledgeArticleTranslationSource(
      tx,
      author.account,
      {
        owner: { sourceId },
        language: "ko",
        sourceRevisionId: current.id,
      },
    );
    assert.equal(acknowledged.status, "ok");
    assert.equal(
      (await getTranslationReviewStates(tx, { sourceId })).contents.get("ko"),
      "current",
    );
  });
});

test("acknowledging a language with neither a draft nor a published version is rejected", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "nothingtoacknowledge",
      name: "Nothing To Acknowledge",
      email: "nothingtoacknowledge@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "nothing-to-acknowledge",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(current != null);
    const result = await acknowledgeArticleTranslationSource(
      tx,
      author.account,
      {
        owner: { sourceId },
        language: "ko",
        sourceRevisionId: current.id,
      },
    );
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") return;
    assert.equal(result.inputPath, "language");
  });
});

test("an in-flight automatic translation cannot be acknowledged", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "inflightackauthor",
      name: "In-flight Ack Author",
      email: "inflightackauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "in-flight-acknowledge",
      tags: [],
      allowLlmTranslation: true,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    // A placeholder still holds the original's text: there is nothing
    // translated to review, and its worker will overwrite the row.
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ko",
      title: "Original title",
      content: "Original body",
      originalLanguage: "en",
      provenance: "llm",
      translationRequesterId: author.account.id,
      beingTranslated: true,
    });
    await updateArticleSource(tx, sourceId, { title: "Edited title" });
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(current != null);

    const result = await acknowledgeArticleTranslationSource(
      tx,
      author.account,
      {
        owner: { sourceId },
        language: "ko",
        sourceRevisionId: current.id,
      },
    );
    assert.equal(result.status, "invalid");
    if (result.status !== "invalid") return;
    assert.equal(result.inputPath, "language");
    const ko = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.equal(ko?.reviewerId, null);
    assert.notEqual(ko?.sourceRevisionId, current.id);
  });
});

test("an unauthorized account cannot acknowledge someone else's translation", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "acknowledgeowner",
      name: "Acknowledge Owner",
      email: "acknowledgeowner@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "acknowledgestranger",
      name: "Acknowledge Stranger",
      email: "acknowledgestranger@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "acknowledge-permission",
      tags: [],
      allowLlmTranslation: false,
      title: "Original title",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await saveArticleTranslationDraft(tx, author.account, {
      sourceId,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
    });
    const current = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(current != null);
    const result = await acknowledgeArticleTranslationSource(
      tx,
      stranger.account,
      {
        owner: { sourceId },
        language: "ko",
        sourceRevisionId: current.id,
      },
    );
    assert.equal(result.status, "forbidden");
  });
});

test("losing a snapshot leaves the review record and an unknown baseline", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "snapshotlossauthor",
      name: "Snapshot Loss Author",
      email: "snapshotlossauthor@example.com",
    });
    const draft = await saveArticleDraft(tx, author.account, {
      title: "Original title",
      content: "Original body",
      language: "en",
      tags: [],
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    const translation = await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
    });
    assert.equal(translation.status, "ok");
    if (translation.status !== "ok") return;
    const baseline = await getCurrentDraftRevision(tx, draft.draft.id);
    assert.ok(baseline != null);
    const acknowledged = await acknowledgeArticleTranslationSource(
      tx,
      author.account,
      {
        owner: { articleDraftId: draft.draft.id },
        language: "ko",
        sourceRevisionId: baseline.id,
      },
    );
    assert.equal(acknowledged.status, "ok");

    // `source_revision_id` is `ON DELETE SET NULL`, so a snapshot can go away
    // under a row that records a review. That must not make the deletion fail:
    // the honest result is a preserved review record with a baseline nobody
    // can resolve, which reads as an unknown baseline rather than as current.
    await tx
      .delete(articleSourceRevisionTable)
      .where(eq(articleSourceRevisionTable.id, baseline.id));
    const stored = await tx.query.articleTranslationDraftTable.findFirst({
      where: { id: translation.draft.id },
    });
    assert.equal(stored?.sourceRevisionId, null);
    assert.ok(stored?.reviewed != null);
    assert.equal(stored?.reviewerId, author.account.id);
    assert.equal(
      getReviewState(stored?.sourceRevisionId, generateUuidV7()),
      "unknownBaseline",
    );
  });
});

test("a draft's current revision follows its pointer, not snapshot timestamps", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "draftpointerauthor",
      name: "Draft Pointer Author",
      email: "draftpointerauthor@example.com",
    });
    const draft = await saveArticleDraft(tx, author.account, {
      title: "Original title",
      content: "Original body",
      language: "en",
      tags: [],
    });
    assert.equal(draft.status, "ok");
    if (draft.status !== "ok") return;
    const translation = await saveArticleTranslationDraft(tx, author.account, {
      articleDraftId: draft.draft.id,
      language: "ko",
      title: "한국어 제목",
      content: "한국어 본문",
    });
    assert.equal(translation.status, "ok");
    if (translation.status !== "ok") return;
    assert.equal(
      (
        await getTranslationReviewStates(tx, { articleDraftId: draft.draft.id })
      ).drafts.get("ko"),
      "current",
    );

    // A snapshot inserted with a newer `created` but no pointer update must
    // not be mistaken for the draft's current revision: `created` is the
    // recording transaction's start time and can invert against commit order.
    await tx.insert(articleSourceRevisionTable).values({
      id: generateUuidV7(),
      articleDraftId: draft.draft.id,
      language: "en",
      title: "Out of band title",
      content: "Out of band body",
      created: new Date("2099-01-01T00:00:00.000Z"),
    });
    assert.equal(
      (
        await getTranslationReviewStates(tx, { articleDraftId: draft.draft.id })
      ).drafts.get("ko"),
      "current",
    );
  });
});
