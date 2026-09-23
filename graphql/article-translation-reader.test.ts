import assert from "node:assert";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import {
  createArticle,
  publishArticleTranslation,
  updateArticleSource,
} from "@hackerspub/models/article";
import { getCurrentSourceRevision } from "@hackerspub/models/article-revision";
import { acknowledgeArticleTranslationSource } from "@hackerspub/models/article-translation-review";
import { saveArticleTranslationDraft } from "@hackerspub/models/article-translation";
import { articleContentTable } from "@hackerspub/models/schema";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const fakeModels = {
  summarizer: {} as never,
  translator: {} as never,
  moderationAnalyzer: {} as never,
};

/**
 * Everything the article page renders about a language version. It is
 * deliberately requested without authentication in most assertions below: the
 * "the original has changed" notice has to survive server-side rendering for a
 * signed-out visitor.
 */
const readerQuery = parse(`
  query ArticleTranslationReader(
    $handle: String!
    $idOrYear: String!
    $slug: String!
  ) {
    articleByYearAndSlug(handle: $handle, idOrYear: $idOrYear, slug: $slug) {
      contents {
        language
        originalLanguage
        provenance
        reviewState
        translator {
          username
        }
        translationRequester {
          username
        }
        reviewedSourceRevision {
          title
        }
        reviewer {
          username
        }
        reviewed
      }
    }
  }
`);

interface ReaderContent {
  language: string;
  originalLanguage: string | null;
  provenance: string | null;
  reviewState: string | null;
  translator: { username: string } | null;
  translationRequester: { username: string } | null;
  reviewedSourceRevision: { title: string } | null;
  reviewer: { username: string } | null;
  reviewed: string | null;
}

async function readContents(
  contextValue: unknown,
  variableValues: Record<string, unknown>,
): Promise<Map<string, ReaderContent>> {
  const result = await execute({
    schema,
    document: readerQuery,
    variableValues,
    contextValue: contextValue as never,
    onError: "NO_PROPAGATE",
  });
  assert.deepEqual(result.errors, undefined);
  const article = (
    result.data as {
      articleByYearAndSlug: { contents: ReaderContent[] } | null;
    }
  ).articleByYearAndSlug;
  assert.ok(article != null);
  return new Map(
    article.contents.map((content) => [content.language, content]),
  );
}

test("a signed-out reader can tell the original, a human translation, and an automatic one apart", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "readercreditauthor",
      name: "Reader Credit Author",
      email: "readercreditauthor@example.com",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "readercreditrequester",
      name: "Reader Credit Requester",
      email: "readercreditrequester@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "reader-credit",
      tags: [],
      allowLlmTranslation: true,
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
    assert.equal(
      (
        await publishArticleTranslation(fedCtx, author.account, {
          translationDraftId: draft.draft.id,
          revision: draft.draft.revision,
        })
      ).status,
      "ok",
    );

    // An automatic translation, as the LLM job leaves it: credited to nobody,
    // with the requester recorded separately.
    await tx.insert(articleContentTable).values({
      sourceId,
      language: "ja",
      title: "日本語のタイトル",
      content: "日本語の本文",
      originalLanguage: "en",
      provenance: "llm",
      translationRequesterId: requester.account.id,
    });

    const variables = {
      handle: author.account.username,
      idOrYear: "2026",
      slug: "reader-credit",
    };
    const contents = await readContents(makeGuestContext(tx), variables);

    const original = contents.get("en");
    assert.equal(original?.originalLanguage, null);
    assert.equal(original?.provenance, null);
    // Review does not apply to the original, so there is nothing to warn about.
    assert.equal(original?.reviewState, null);

    const human = contents.get("ko");
    assert.equal(human?.provenance, "HUMAN");
    assert.equal(human?.translator?.username, "readercreditauthor");
    assert.equal(human?.translationRequester, null);
    assert.equal(human?.reviewState, "CURRENT");

    const automatic = contents.get("ja");
    assert.equal(automatic?.provenance, "LLM");
    assert.equal(automatic?.translator, null);
    // The requester is not a translator, and the reader UI never presents them
    // as one; it is readable only so the API can distinguish the two roles.
    assert.equal(
      automatic?.translationRequester?.username,
      "readercreditrequester",
    );
    // No baseline was ever recorded for it, which must read as unverified
    // freshness rather than as a known source change.
    assert.equal(automatic?.reviewState, "UNKNOWN_BASELINE");
  });
});

test("private editing evidence stays out of a reader's view", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "readerevidenceauthor",
      name: "Reader Evidence Author",
      email: "readerevidenceauthor@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "readerevidencestranger",
      name: "Reader Evidence Stranger",
      email: "readerevidencestranger@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "reader-evidence",
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
    const baseline = await getCurrentSourceRevision(tx, sourceId);
    assert.ok(baseline != null);
    assert.equal(
      (
        await publishArticleTranslation(fedCtx, author.account, {
          translationDraftId: draft.draft.id,
          revision: draft.draft.revision,
          sourceRevisionId: baseline.id,
        })
      ).status,
      "ok",
    );
    // A second language that stays a private draft.
    assert.equal(
      (
        await saveArticleTranslationDraft(tx, author.account, {
          sourceId,
          language: "ja",
          title: "日本語のタイトル",
          content: "日本語の本文",
        })
      ).status,
      "ok",
    );

    const variables = {
      handle: author.account.username,
      idOrYear: "2026",
      slug: "reader-evidence",
    };
    for (const contextValue of [
      makeGuestContext(tx),
      makeUserContext(tx, stranger.account),
    ]) {
      const contents = await readContents(contextValue, variables);
      // The unpublished language is not a language version yet.
      assert.deepEqual([...contents.keys()].sort(), ["en", "ko"]);
      const korean = contents.get("ko");
      // The public signal is readable; the snapshot it was compared against,
      // who compared it, and when are editing records.
      assert.equal(korean?.reviewState, "CURRENT");
      assert.equal(korean?.reviewedSourceRevision, null);
      assert.equal(korean?.reviewer, null);
      assert.equal(korean?.reviewed, null);
    }

    // Its editor sees the evidence.
    const owned = await readContents(
      makeUserContext(tx, author.account),
      variables,
    );
    assert.equal(
      owned.get("ko")?.reviewedSourceRevision?.title,
      "Original title",
    );
    assert.equal(owned.get("ko")?.reviewer?.username, "readerevidenceauthor");
    assert.ok(owned.get("ko")?.reviewed != null);
  });
});

test("a source edit makes a reader's notice appear, and only a review clears it", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "readerfreshauthor",
      name: "Reader Freshness Author",
      email: "readerfreshauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "reader-freshness",
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
    assert.equal(
      (
        await publishArticleTranslation(fedCtx, author.account, {
          translationDraftId: draft.draft.id,
          revision: draft.draft.revision,
        })
      ).status,
      "ok",
    );

    const variables = {
      handle: author.account.username,
      idOrYear: "2026",
      slug: "reader-freshness",
    };
    const guest = () => readContents(makeGuestContext(tx), variables);
    assert.equal((await guest()).get("ko")?.reviewState, "CURRENT");

    // Publishing a change to the original is what a reader has to be told
    // about.
    const edited = await updateArticleSource(tx, sourceId, {
      title: "New title",
    });
    assert.ok(edited?.sourceRevision != null);
    assert.equal((await guest()).get("ko")?.reviewState, "NEEDS_REVIEW");

    // Saving a private draft is not a review: the version readers see is
    // unchanged, so the notice must stay.
    assert.equal(
      (
        await saveArticleTranslationDraft(tx, author.account, {
          sourceId,
          language: "ko",
          title: "한국어 제목 2",
          content: "한국어 본문 2",
        })
      ).status,
      "ok",
    );
    assert.equal((await guest()).get("ko")?.reviewState, "NEEDS_REVIEW");

    // Acknowledging the revision the editor was actually shown clears it,
    // without touching the translated text.
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
    assert.equal((await guest()).get("ko")?.reviewState, "CURRENT");

    // A later source edit starts a new outstanding change; the old
    // acknowledgement spoke only for the revision it named.
    assert.ok(
      (await updateArticleSource(tx, sourceId, { content: "Newer body" }))
        ?.sourceRevision != null,
    );
    assert.equal((await guest()).get("ko")?.reviewState, "NEEDS_REVIEW");
  });
});

test("deleting the translator's account does not turn a human translation automatic", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "readerdeletedauthor",
      name: "Reader Deleted Author",
      email: "readerdeletedauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "reader-deleted-translator",
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
    assert.equal(
      (
        await publishArticleTranslation(fedCtx, author.account, {
          translationDraftId: draft.draft.id,
          revision: draft.draft.revision,
        })
      ).status,
      "ok",
    );

    // Deleting the credited account leaves the column null through the
    // `ON DELETE SET NULL` foreign key; write that state directly, because a
    // personal article credits its own author and deleting them would take the
    // article with it.
    await tx
      .update(articleContentTable)
      .set({ translatorId: null })
      .where(
        and(
          eq(articleContentTable.sourceId, sourceId),
          eq(articleContentTable.language, "ko"),
        ),
      );

    const contents = await readContents(makeGuestContext(tx), {
      handle: author.account.username,
      idOrYear: "2026",
      slug: "reader-deleted-translator",
    });
    const korean = contents.get("ko");
    // The account reference is gone, but the provenance is what the reader
    // label is built from, so the version still reads as human work with an
    // unavailable credit rather than as an automatic translation.
    assert.equal(korean?.translator, null);
    assert.equal(korean?.provenance, "HUMAN");
    assert.equal(korean?.translationRequester, null);
  });
});
