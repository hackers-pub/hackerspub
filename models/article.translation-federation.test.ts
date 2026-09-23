// FEP-22cd translation federation, pinned to the draft revision Fedify
// 2.4.0-dev.1988 targets:
// https://codeberg.org/fediverse/fep/src/commit/6d0d6559054baeb7b71a5f2bdc14fc4c09b66f39/fep/22cd/fep-22cd.md
import assert from "node:assert";
import test from "node:test";
import { Article, LanguageString, Update } from "@fedify/vocab";
import { eq } from "drizzle-orm";
import { deleteAccount } from "./account.ts";
import {
  acknowledgeArticleTranslation,
  createArticle,
  publishArticleTranslation,
  startArticleContentTranslation,
  updateArticle,
  withdrawArticleTranslation,
} from "./article.ts";
import { bumpArticleVersion } from "./article-publication.ts";
import { getCurrentSourceRevision } from "./article-revision.ts";
import { saveArticleTranslationDraft } from "./article-translation.ts";
import type { ApplicationContext } from "./context.ts";
import type { Transaction } from "./db.ts";
import { ActorSuspendedError } from "./moderation.ts";
import {
  actorTable,
  articleContentTable,
  articleSourceTable,
  organizationMembershipTable,
} from "./schema.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";
import { waitFor } from "../test/wait.ts";

const fakeModels = {
  summarizer: {} as never,
  translator: {} as never,
  moderationAnalyzer: {} as never,
};

const INSTANCE_ACTOR = "http://localhost/actors/localhost";

function capture(tx: Transaction) {
  const updates: Update[] = [];
  const fedCtx = createFedCtx(tx);
  fedCtx.models = fakeModels as typeof fedCtx.models;
  fedCtx.sendActivity = ((
    _sender: unknown,
    _to: unknown,
    activity: unknown,
  ) => {
    if (activity instanceof Update) updates.push(activity);
    return Promise.resolve(undefined);
  }) as typeof fedCtx.sendActivity;
  return { fedCtx, updates };
}

async function lastArticle(
  fedCtx: ApplicationContext,
  updates: readonly Update[],
): Promise<Article> {
  const update = updates.at(-1);
  assert.ok(update != null, "no Update was federated");
  const object = await update.getObject({ ...fedCtx, suppressError: true });
  assert.ok(object instanceof Article);
  return object;
}

function contentIn(article: Article, language: string): string | undefined {
  return article.contents
    .find(
      (value) =>
        value instanceof LanguageString && value.locale.baseName === language,
    )
    ?.toString();
}

function referenceOf(article: Article) {
  return (article.updated ?? article.published)!;
}

async function publishTranslation(
  fedCtx: ApplicationContext<Transaction>,
  account: Parameters<typeof saveArticleTranslationDraft>[1],
  sourceId: `${string}-${string}-${string}-${string}-${string}`,
  language: string,
  text: { title: string; content: string },
  translatorId?: `${string}-${string}-${string}-${string}-${string}`,
) {
  const saved = await saveArticleTranslationDraft(fedCtx.db, account, {
    sourceId,
    language,
    ...text,
    ...(translatorId == null ? {} : { translatorId }),
  });
  assert.equal(saved.status, "ok");
  if (saved.status !== "ok") throw new Error("unreachable");
  const revision = await getCurrentSourceRevision(fedCtx.db, sourceId);
  const published = await publishArticleTranslation(
    fedCtx,
    account as Parameters<typeof publishArticleTranslation>[1],
    {
      translationDraftId: saved.draft.id,
      revision: saved.draft.revision,
      sourceRevisionId: revision?.id ?? null,
    },
  );
  assert.equal(published.status, "ok");
  return saved.draft;
}

test("an organization article credits each language's translator separately", async () => {
  await withRollback(async (tx) => {
    const { fedCtx, updates } = capture(tx);
    const org = await insertAccountWithActor(tx, {
      username: "fedorg",
      name: "Federated Organization",
      email: "fedorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const bob = await insertAccountWithActor(tx, {
      username: "fedbob",
      name: "Bob",
      email: "fedbob@example.com",
    });
    const carol = await insertAccountWithActor(tx, {
      username: "fedcarol",
      name: "Carol",
      email: "fedcarol@example.com",
    });
    for (const member of [bob, carol]) {
      await tx.insert(organizationMembershipTable).values({
        organizationAccountId: org.account.id,
        memberAccountId: member.account.id,
        role: "member",
        invitedById: member.account.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
    }
    const article = await createArticle(fedCtx, {
      accountId: org.account.id,
      publishedYear: 2026,
      slug: "two-translators",
      tags: [],
      allowLlmTranslation: false,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await publishTranslation(fedCtx, bob.account, sourceId, "ja", {
      title: "日本語版",
      content: "日本語の本文",
    });
    await publishTranslation(fedCtx, carol.account, sourceId, "ko", {
      title: "한국어판",
      content: "한국어 본문",
    });

    assert.equal(updates.length, 2);
    // Each change is its own activity, sent by the publishing organization.
    assert.notEqual(updates[0].id?.href, updates[1].id?.href);
    for (const update of updates) {
      assert.deepEqual(
        update.actorIds.map((id) => id.href),
        [`http://localhost/actors/${org.account.id}`],
      );
    }
    const object = await lastArticle(fedCtx, updates);
    // Translators never become authors of the article.
    assert.deepEqual(
      object.attributionIds.map((id) => id.href),
      [`http://localhost/actors/${org.account.id}`],
    );
    const byLanguage = new Map(
      object.translations.map((t) => [t.language?.baseName, t]),
    );
    assert.deepEqual([...byLanguage.keys()].sort(), ["ja", "ko"]);
    assert.deepEqual(
      byLanguage.get("ja")?.translatorIds.map((id) => id.href),
      [`http://localhost/actors/${bob.account.id}`],
    );
    assert.deepEqual(
      byLanguage.get("ko")?.translatorIds.map((id) => id.href),
      [`http://localhost/actors/${carol.account.id}`],
    );
    for (const translation of object.translations) {
      assert.equal(translation.original?.href, object.id?.href);
      // Both reviewed against the current original, so both are current even
      // though publishing the second language moved the object version.
      assert.equal(
        translation.sourceUpdated?.toString(),
        referenceOf(object).toString(),
      );
      assert.equal(translation.basis, null);
    }
    assert.equal(
      byLanguage.get("ko")?.url?.toString(),
      "http://localhost/@fedorg/2026/two-translators/ko",
    );
    // Readable credit in the translation's own language, with a link to the
    // original language that cannot negotiate back to a translation.
    const ko = contentIn(object, "ko");
    assert.ok(ko?.includes("@fedcarol@localhost"));
    assert.ok(ko?.includes("번역"));
    assert.ok(
      ko?.includes('href="http://localhost/@fedorg/2026/two-translators/en"'),
    );
    assert.ok(!ko?.includes("<blockquote>"));
    assert.ok(contentIn(object, "ja")?.includes("による翻訳"));
    // The original language carries no credit or notice.
    assert.ok(!contentIn(object, "en")?.includes("fedcarol"));
    // The untagged fallback lists each translation with its own credit.
    const fallback = object.contents
      .find((value) => !(value instanceof LanguageString))
      ?.toString();
    assert.ok(fallback?.includes('<li lang="ko">'));
    assert.ok(fallback?.includes("@fedcarol@localhost"));

    const variants = await tx.query.postContentVariantTable.findMany({
      where: { postId: article.id },
      orderBy: { language: "asc" },
    });
    assert.deepEqual(
      variants.map((v) => [v.language, v.default, v.translationKind]),
      [
        ["en", true, null],
        ["ja", false, "human"],
        ["ko", false, "human"],
      ],
    );
  });
});

test("a source edit federates staleness, and a review acknowledgement clears it", async () => {
  await withRollback(async (tx) => {
    const { fedCtx, updates } = capture(tx);
    const author = await insertAccountWithActor(tx, {
      username: "fedstale",
      name: "Stale Author",
      email: "fedstale@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "stale-then-reviewed",
      tags: [],
      allowLlmTranslation: false,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await publishTranslation(fedCtx, author.account, sourceId, "ko", {
      title: "원문",
      content: "한국어 본문",
    });
    const before = await lastArticle(fedCtx, updates);
    const reviewedAgainst = before.translations[0].sourceUpdated;
    assert.ok(reviewedAgainst != null);
    assert.ok(contentIn(before, "ko")?.includes("작성자가 직접 번역"));

    await updateArticle(
      fedCtx,
      sourceId,
      { content: "Edited body" },
      { editor: { accountId: author.account.id } },
    );
    const stale = await lastArticle(fedCtx, updates);
    assert.ok(
      Temporal.Instant.compare(referenceOf(stale), referenceOf(before)) > 0,
    );
    // The last value peers were told, now earlier than the reference.
    assert.equal(
      stale.translations[0].sourceUpdated?.toString(),
      reviewedAgainst.toString(),
    );
    assert.ok(contentIn(stale, "ko")?.includes("원문이 변경되었습니다"));

    const revision = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(revision != null);
    const sent = updates.length;
    const acknowledged = await acknowledgeArticleTranslation(
      fedCtx,
      author.account,
      { owner: { sourceId }, language: "ko", sourceRevisionId: revision.id },
    );
    assert.equal(acknowledged.status, "ok");
    assert.equal(updates.length, sent + 1);
    const reviewed = await lastArticle(fedCtx, updates);
    assert.equal(
      reviewed.translations[0].sourceUpdated?.toString(),
      referenceOf(reviewed).toString(),
    );
    assert.ok(!contentIn(reviewed, "ko")?.includes("<blockquote>"));
    // Only the freshness metadata moved; the translated body is unchanged.
    assert.ok(contentIn(reviewed, "ko")?.includes("한국어 본문"));

    // Re-acknowledging the same revision changes nothing public.
    await acknowledgeArticleTranslation(fedCtx, author.account, {
      owner: { sourceId },
      language: "ko",
      sourceRevisionId: revision.id,
    });
    assert.equal(updates.length, sent + 1);
  });
});

test("withdrawing a translation omits both its content and its metadata", async () => {
  await withRollback(async (tx) => {
    const { fedCtx, updates } = capture(tx);
    const author = await insertAccountWithActor(tx, {
      username: "fedwithdraw",
      name: "Withdraw Author",
      email: "fedwithdraw@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "withdrawn-language",
      tags: [],
      allowLlmTranslation: false,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await publishTranslation(fedCtx, author.account, sourceId, "ko", {
      title: "한국어",
      content: "한국어 본문",
    });
    await publishTranslation(fedCtx, author.account, sourceId, "ja", {
      title: "日本語",
      content: "日本語の本文",
    });
    const withBoth = await lastArticle(fedCtx, updates);

    const result = await withdrawArticleTranslation(fedCtx, author.account, {
      sourceId,
      language: "ko",
    });
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.translationDraft?.publishedRevision, null);
    const withdrawn = await lastArticle(fedCtx, updates);
    // Same object; a Delete would have removed the whole article.
    assert.equal(withdrawn.id?.href, withBoth.id?.href);
    assert.equal(contentIn(withdrawn, "ko"), undefined);
    assert.deepEqual(
      withdrawn.translations.map((t) => t.language?.baseName),
      ["ja"],
    );
    // The remaining translation stays current across the withdrawal.
    assert.equal(
      withdrawn.translations[0].sourceUpdated?.toString(),
      referenceOf(withdrawn).toString(),
    );
    const variants = await tx.query.postContentVariantTable.findMany({
      where: { postId: article.id },
    });
    assert.deepEqual(variants.map((v) => v.language).sort(), ["en", "ja"]);

    // The original can never be withdrawn this way.
    const original = await withdrawArticleTranslation(fedCtx, author.account, {
      sourceId,
      language: "en",
    });
    assert.deepEqual(original, { status: "invalid", inputPath: "language" });
  });
});

test("machine, reviewed-machine, legacy, and in-progress versions are classified honestly", async () => {
  await withRollback(async (tx) => {
    const { fedCtx } = capture(tx);
    const author = await insertAccountWithActor(tx, {
      username: "fedprovenance",
      name: "Provenance Author",
      email: "fedprovenance@example.com",
    });
    const reviewer = await insertAccountWithActor(tx, {
      username: "fedreviewer",
      name: "Reviewer",
      email: "fedreviewer@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "provenance-matrix",
      tags: [],
      allowLlmTranslation: true,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const revision = await getCurrentSourceRevision(tx, sourceId);
    const base = { sourceId, originalLanguage: "en" };
    await tx.insert(articleContentTable).values([
      {
        ...base,
        language: "fr",
        title: "Traduction automatique",
        content: "Texte",
        provenance: "llm",
        translationRequesterId: reviewer.account.id,
        sourceRevisionId: revision?.id,
      },
      {
        ...base,
        language: "de",
        title: "Geprüft",
        content: "Text",
        provenance: "llm_reviewed",
        translatorId: reviewer.account.id,
        sourceRevisionId: revision?.id,
      },
      {
        ...base,
        language: "es",
        title: "Legado",
        content: "Texto",
        provenance: "unknown",
      },
      {
        ...base,
        language: "it",
        // A running automatic job holds the original's text.
        title: "Original",
        content: "Original body",
        provenance: "llm",
        beingTranslated: true,
      },
    ]);
    const source = await tx.query.articleSourceTable.findFirst({
      where: { id: sourceId },
      with: { account: true, contents: true },
    });
    assert.ok(source != null);
    const object = await fedCtx.services.federation.getArticle(fedCtx, source);
    const byLanguage = new Map(
      object.translations.map((t) => [t.language?.baseName, t]),
    );
    assert.deepEqual([...byLanguage.keys()].sort(), ["de", "es", "fr"]);
    assert.equal(contentIn(object, "it"), undefined);
    assert.deepEqual(
      byLanguage.get("fr")?.translatorIds.map((id) => id.href),
      [INSTANCE_ACTOR],
    );
    // Unreviewed machine output makes no freshness claim.
    assert.equal(byLanguage.get("fr")?.sourceUpdated, null);
    assert.deepEqual(
      byLanguage
        .get("de")
        ?.translatorIds.map((id) => id.href)
        .sort(),
      [INSTANCE_ACTOR, `http://localhost/actors/${reviewer.account.id}`].sort(),
    );
    assert.ok(byLanguage.get("de")?.sourceUpdated != null);
    // A legacy version keeps an entry, so peers do not read it as written by
    // the author, but names nobody and makes no freshness claim.
    assert.deepEqual(byLanguage.get("es")?.translatorIds, []);
    assert.equal(byLanguage.get("es")?.sourceUpdated, null);
    assert.ok(contentIn(object, "es")?.includes("<blockquote>"));
    // Languages without catalog wording fall back to English.
    assert.ok(contentIn(object, "fr")?.includes("Automatic translation"));
  });
});

test("deleting a translator keeps their actor IRI and the human classification", async () => {
  await withRollback(async (tx) => {
    const { fedCtx } = capture(tx);
    const author = await insertAccountWithActor(tx, {
      username: "fedkeepauthor",
      name: "Keep Author",
      email: "fedkeepauthor@example.com",
    });
    const translator = await insertAccountWithActor(tx, {
      username: "fedgone",
      name: "Gone Translator",
      email: "fedgone@example.com",
    });
    const org = await insertAccountWithActor(tx, {
      username: "fedkeeporg",
      name: "Keep Organization",
      email: "fedkeeporg@example.com",
      kind: "organization",
      type: "Organization",
    });
    for (const member of [author, translator]) {
      await tx.insert(organizationMembershipTable).values({
        organizationAccountId: org.account.id,
        memberAccountId: member.account.id,
        role: "member",
        invitedById: member.account.id,
        accepted: new Date("2026-04-15T00:00:00.000Z"),
      });
    }
    const article = await createArticle(fedCtx, {
      accountId: org.account.id,
      publishedYear: 2026,
      slug: "deleted-translator",
      tags: [],
      allowLlmTranslation: false,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await publishTranslation(fedCtx, translator.account, sourceId, "ko", {
      title: "번역",
      content: "번역 본문",
    });
    const deleted = await deleteAccount(fedCtx, translator.account.id);
    assert.ok(deleted != null);

    const row = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.equal(row?.translatorId, null);
    assert.equal(row?.deletedTranslatorId, translator.account.id);
    assert.equal(row?.provenance, "human");
    const source = await tx.query.articleSourceTable.findFirst({
      where: { id: sourceId },
      with: { account: true, contents: true },
    });
    assert.ok(source != null);
    const object = await fedCtx.services.federation.getArticle(fedCtx, source);
    assert.deepEqual(
      object.translations[0].translatorIds.map((id) => id.href),
      [`http://localhost/actors/${translator.account.id}`],
    );
    assert.ok(
      contentIn(object, "ko")?.includes("번역자 계정을 사용할 수 없음"),
    );
  });
});

test("the object version always moves strictly forward", async () => {
  await withRollback(async (tx) => {
    const { fedCtx } = capture(tx);
    const author = await insertAccountWithActor(tx, {
      username: "fedmonotonic",
      name: "Monotonic",
      email: "fedmonotonic@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "monotonic-version",
      tags: [],
      allowLlmTranslation: false,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    // A far-future version must still be exceeded, never reused.
    const future = new Date(Date.now() + 60_000);
    await tx
      .update(articleSourceTable)
      .set({ updated: future })
      .where(eq(articleSourceTable.id, article.articleSource.id));
    const first = await bumpArticleVersion(tx, article.articleSource.id);
    const second = await bumpArticleVersion(tx, article.articleSource.id);
    assert.ok(first != null && second != null);
    assert.ok(+first > +future);
    assert.ok(+second > +first);
  });
});

test("a delayed automatic result cannot restore superseded text or credit", async () => {
  await withRollback(async (tx) => {
    const { fedCtx, updates } = capture(tx);
    const release = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    fedCtx.data.services = {
      ...fedCtx.data.services,
      ai: {
        ...fedCtx.data.services.ai,
        translate: () => {
          started.resolve();
          return release.promise;
        },
      },
    };
    const author = await insertAccountWithActor(tx, {
      username: "feddelayed",
      name: "Delayed",
      email: "feddelayed@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "delayed-automatic",
      tags: [],
      allowLlmTranslation: true,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    const original = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "en" },
    });
    assert.ok(original != null);
    await startArticleContentTranslation(fedCtx, {
      content: original,
      targetLanguage: "ko",
      requester: author.account,
    });
    await started.promise;
    // The placeholder is never federated.
    assert.equal(updates.length, 0);

    await publishTranslation(fedCtx, author.account, sourceId, "ko", {
      title: "사람이 쓴 번역",
      content: "사람이 쓴 본문",
    });
    const sent = updates.length;
    release.resolve("# 자동 번역\n\n자동 번역 본문");
    await waitFor(async () => {
      const row = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "ko" },
      });
      return row?.translationJobToken == null;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const row = await tx.query.articleContentTable.findFirst({
      where: { sourceId, language: "ko" },
    });
    assert.equal(row?.title, "사람이 쓴 번역");
    assert.equal(row?.provenance, "human");
    // The fenced-off job federated nothing.
    assert.equal(updates.length, sent);
    const object = await lastArticle(fedCtx, updates);
    assert.deepEqual(
      object.translations[0].translatorIds.map((id) => id.href),
      [`http://localhost/actors/${author.account.id}`],
    );
  });
});

test("a suspended author cannot federate a review acknowledgement", async () => {
  await withRollback(async (tx) => {
    const { fedCtx, updates } = capture(tx);
    const author = await insertAccountWithActor(tx, {
      username: "fedsuspendedack",
      name: "Suspended",
      email: "fedsuspendedack@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "suspended-ack",
      tags: [],
      allowLlmTranslation: false,
      title: "Original",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const sourceId = article.articleSource.id;
    await publishTranslation(fedCtx, author.account, sourceId, "ko", {
      title: "번역",
      content: "번역 본문",
    });
    await updateArticle(fedCtx, sourceId, { content: "Edited" });
    const revision = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(revision != null);
    await tx
      .update(actorTable)
      .set({ suspended: new Date(Date.now() - 1000) })
      .where(eq(actorTable.accountId, author.account.id));
    const sent = updates.length;
    await assert.rejects(
      acknowledgeArticleTranslation(fedCtx, author.account, {
        owner: { sourceId },
        language: "ko",
        sourceRevisionId: revision.id,
      }),
      ActorSuspendedError,
    );
    assert.equal(updates.length, sent);
  });
});
