import assert from "node:assert";
import test from "node:test";
import {
  applyArticleContentSummary,
  startArticleContentSummary,
  updateArticleSource,
} from "./article.ts";
import {
  articleContentTable,
  articleSourceTable,
  postTable,
} from "./schema.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";
import { generateUuidV7 } from "./uuid.ts";

test(
  "applyArticleContentSummary() saves the summary when shorter than the original",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summaryapply1",
        name: "Summary Apply 1",
        email: "summaryapply1@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");
      const longContent =
        "This is a much longer article body that has plenty of words " +
        "so that the summary can fit comfortably below the length of " +
        "the original content without difficulty.";

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-apply-shorter",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Apply shorter summary",
        content: longContent,
        summaryStarted: published,
        published,
        updated: published,
      });

      const content = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(content != null);

      await applyArticleContentSummary(tx, content, "Short summary.");

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summary, "Short summary.");
      assert.equal(after?.summaryUnnecessary, false);
      // The summarization claim must be released after a successful save.
      assert.equal(after?.summaryStarted, null);
      // The row's updated timestamp must reflect the new summary.
      assert.ok(after != null);
      assert.ok(after.updated.getTime() > published.getTime());
    });
  },
);

test(
  "applyArticleContentSummary() discards summary and marks unnecessary " +
    "when summary is not shorter than the original",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summaryapply2",
        name: "Summary Apply 2",
        email: "summaryapply2@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");
      const shortContent = "Hello.";
      const longSummary =
        "This summary is far longer than the original article body itself.";

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-apply-longer",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Apply longer summary",
        content: shortContent,
        summaryStarted: published,
        published,
        updated: published,
      });

      const content = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(content != null);

      await applyArticleContentSummary(tx, content, longSummary);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summary, null);
      assert.equal(after?.summaryUnnecessary, true);
      assert.equal(after?.summaryStarted, null);
      // The row's updated timestamp must reflect the discard decision.
      assert.ok(after != null);
      assert.ok(after.updated.getTime() > published.getTime());
    });
  },
);

test(
  "applyArticleContentSummary() clears a stale article_content.summary " +
    "when discarding",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summaryapplystale",
        name: "Summary Apply Stale",
        email: "summaryapplystale@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");
      const shortContent = "Hi.";
      const longSummary =
        "This summary is much longer than the article body itself.";

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-apply-stale",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Apply summary stale",
        content: shortContent,
        summary: "Stale summary that should be cleared.",
        summaryStarted: published,
        published,
        updated: published,
      });

      const content = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(content != null);

      await applyArticleContentSummary(tx, content, longSummary);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summary, null);
      assert.equal(after?.summaryUnnecessary, true);
    });
  },
);

test(
  "startArticleContentSummary() skips rows already marked summaryUnnecessary",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summaryskip",
        name: "Summary Skip",
        email: "summaryskip@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-skip",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Skip summary",
        content: "Body",
        summaryUnnecessary: true,
        published,
        updated: published,
      });

      const content = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(content != null);

      // Even though we pass a fake model, this should never be invoked
      // because the row is marked unnecessary.
      await startArticleContentSummary(tx, {} as never, content);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summaryUnnecessary, true);
      assert.equal(after?.summaryStarted, null);
      assert.equal(after?.summary, null);
    });
  },
);

test(
  "applyArticleContentSummary() clears the post-level summary when discarding",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summaryapply3",
        name: "Summary Apply 3",
        email: "summaryapply3@example.com",
      });
      const sourceId = generateUuidV7();
      const postId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");
      const shortContent = "Hi.";
      const longSummary =
        "This summary is much longer than the article body itself.";

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-apply-post",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Apply summary post",
        content: shortContent,
        summaryStarted: published,
        published,
        updated: published,
      });
      await tx.insert(postTable).values({
        id: postId,
        iri: `https://example.com/posts/${postId}`,
        type: "Article",
        actorId: author.actor.id,
        articleSourceId: sourceId,
        name: "Apply summary post",
        contentHtml: "<p>Hi.</p>",
        language: "en",
        summary: "Pre-existing summary that should be cleared.",
        visibility: "public",
        url: `https://example.com/posts/${postId}`,
        published,
        updated: published,
      });

      const content = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(content != null);

      await applyArticleContentSummary(tx, content, longSummary);

      const after = await tx.query.postTable.findFirst({
        where: { id: postId },
      });
      assert.equal(after?.summary, null);
    });
  },
);

test(
  "updateArticleSource() clears summaryUnnecessary when content changes",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summaryreset",
        name: "Summary Reset",
        email: "summaryreset@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-reset",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Reset summary",
        content: "Hi.",
        summary: null,
        summaryStarted: published,
        summaryUnnecessary: true,
        published,
        updated: published,
      });

      const updated = await updateArticleSource(tx, sourceId, {
        content: "This article body has now grown long enough to be worth " +
          "summarizing again, so we expect the unnecessary mark to clear.",
      });
      assert.ok(updated != null);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summaryUnnecessary, false);
      assert.equal(after?.summary, null);
      assert.equal(after?.summaryStarted, null);
    });
  },
);

test(
  "updateArticleSource() preserves summary state when content is unchanged",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summarykeep",
        name: "Summary Keep",
        email: "summarykeep@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-keep",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Keep summary",
        content: "Original body.",
        summary: "Cached summary.",
        summaryUnnecessary: false,
        published,
        updated: published,
      });

      // Update only the title; the body is unchanged so the existing
      // summary should remain intact.
      const updated = await updateArticleSource(tx, sourceId, {
        title: "Renamed",
      });
      assert.ok(updated != null);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summary, "Cached summary.");
      assert.equal(after?.summaryUnnecessary, false);
    });
  },
);

test(
  "applyArticleContentSummary() drops the result when the content " +
    "changed during summarization",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summaryrace",
        name: "Summary Race",
        email: "summaryrace@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");
      const shortOriginal = "Hi.";
      const longUpdated =
        "This article has been edited to be much longer than before, " +
        "so the in-flight summary—generated from the old body—should " +
        "not be saved here; instead the row is freed for a new attempt.";
      const staleSummary = "A summary written for the old short body.";

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-race",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Race",
        content: shortOriginal,
        summaryStarted: published,
        published,
        updated: published,
      });

      // Capture the snapshot the summarizer would have started from.
      const snapshot = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(snapshot != null);

      // Simulate the user editing the article while the summarizer is
      // still in flight.  `updateArticleSource()` clears the summary
      // state because the body changed.
      const edited = await updateArticleSource(tx, sourceId, {
        content: longUpdated,
      });
      assert.ok(edited != null);

      // The summarizer's promise resolves now, but with the *old*
      // snapshot.  The function must drop the stale summary and free
      // the row so the next call can resummarize the new body.
      await applyArticleContentSummary(tx, snapshot, staleSummary);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summary, null);
      assert.equal(after?.summaryUnnecessary, false);
      assert.equal(after?.summaryStarted, null);
    });
  },
);

test(
  "updateArticleSource() clears summary state when only language changes",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summarylangchange",
        name: "Summary Lang Change",
        email: "summarylangchange@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-lang-change",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Cached English",
        content: "Original body",
        summary: "An English summary that no longer matches the language.",
        summaryUnnecessary: false,
        published,
        updated: published,
      });

      const updated = await updateArticleSource(tx, sourceId, {
        language: "ko",
      });
      assert.ok(updated != null);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "ko" },
      });
      assert.equal(after?.summary, null);
      assert.equal(after?.summaryUnnecessary, false);
      assert.equal(after?.summaryStarted, null);
    });
  },
);

test(
  "updateArticleSource() queues a re-summarization when content changes " +
    "and models are provided",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summaryrequeue",
        name: "Summary Requeue",
        email: "summaryrequeue@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-requeue",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      // Row is in the steady "no summary needed" state.  After the
      // edit, we expect the reset path to fire AND summarization to
      // be queued so a fresh attempt runs against the new body.
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Original",
        content: "Hi.",
        summary: null,
        summaryUnnecessary: true,
        published,
        updated: published,
      });

      // Use a model whose `summarize()` Promise never resolves, so the
      // background `.then`/`.catch` handlers cannot race with our
      // assertions or with `withRollback`'s teardown.  All we want to
      // verify is that the synchronous claim-acquisition step ran.
      const hangingPromise = new Promise<never>(() => {});
      const hangingModel = {
        // Just enough surface for `generateText` to start without
        // crashing synchronously in summarize().
        specificationVersion: "v2",
        provider: "test",
        modelId: "hanging",
        doGenerate: () => hangingPromise,
        doStream: () => hangingPromise,
        supportedUrls: {},
      } as unknown as never;

      const updated = await updateArticleSource(
        tx,
        sourceId,
        {
          content: "This article body is now long enough to be worth " +
            "summarizing again, so we expect a fresh claim to be acquired.",
        },
        { summarizer: hangingModel, translator: hangingModel },
      );
      assert.ok(updated != null);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summaryUnnecessary, false);
      assert.equal(after?.summary, null);
      assert.ok(after?.summaryStarted != null);
    });
  },
);

test(
  "updateArticleSource() does not queue summarization when content is " +
    "unchanged",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summarynorequeue",
        name: "Summary No Requeue",
        email: "summarynorequeue@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-no-requeue",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Title only edit",
        content: "Original body",
        summary: "Cached summary.",
        published,
        updated: published,
      });

      // Title-only edits must not enqueue a fresh summarization.
      const updated = await updateArticleSource(
        tx,
        sourceId,
        { title: "Renamed" },
        { summarizer: {} as never, translator: {} as never },
      );
      assert.ok(updated != null);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summary, "Cached summary.");
      assert.equal(after?.summaryStarted, null);
    });
  },
);

test(
  "applyArticleContentSummary() refuses to update when a newer claim " +
    "has taken over the row",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summarycas",
        name: "Summary CAS",
        email: "summarycas@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");
      const oldClaim = new Date("2026-04-15T00:00:00.000Z");
      const newClaim = new Date("2026-04-15T01:00:00.000Z");
      const body =
        "An article body long enough to comfortably accept a summary " +
        "from the in-flight call below.";

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-cas",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      // The current row has been re-claimed by a newer summarization.
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "CAS",
        content: body,
        summaryStarted: newClaim,
        published,
        updated: published,
      });

      // The stale snapshot represents the older claim that is finishing now.
      const snapshot = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(snapshot != null);

      await applyArticleContentSummary(
        tx,
        snapshot,
        "Short.",
        oldClaim,
      );

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      // The newer claim is preserved; the older summarization's result
      // is ignored entirely.
      assert.equal(after?.summary, null);
      assert.equal(after?.summaryStarted?.getTime(), newClaim.getTime());
    });
  },
);

test(
  "startArticleContentSummary() skips rows that are still being translated",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summarytranslating",
        name: "Summary Translating",
        email: "summarytranslating@example.com",
      });
      const requester = await insertAccountWithActor(tx, {
        username: "summarytransreq",
        name: "Summary Translation Requester",
        email: "summarytransreq@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-translating",
        tags: [],
        allowLlmTranslation: true,
        published,
        updated: published,
      });
      // The original-language row that the translation references.
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Original",
        content: "Original body that has not been translated yet.",
        published,
        updated: published,
      });
      // Placeholder for an in-flight translation: content is still the
      // original-language body.
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "ko",
        title: "Original placeholder",
        content: "Original body that has not been translated yet.",
        beingTranslated: true,
        originalLanguage: "en",
        translationRequesterId: requester.account.id,
        published,
        updated: published,
      });

      const content = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "ko" },
      });
      assert.ok(content != null);

      // Should be a no-op because the row is being translated.  The
      // fake model would otherwise crash if generateText() were called.
      await startArticleContentSummary(tx, {} as never, content);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "ko" },
      });
      assert.equal(after?.summaryStarted, null);
      assert.equal(after?.beingTranslated, true);
    });
  },
);

test(
  "applyArticleContentSummary() discards empty or whitespace-only summaries " +
    "even when the original is one grapheme",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summaryapplyempty",
        name: "Summary Apply Empty",
        email: "summaryapplyempty@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");
      // Original is a single grapheme, so any non-empty summary that
      // is shorter cannot exist.  An empty summary would be technically
      // shorter (0 < 1) but is not useful, so we expect the discard
      // path to take it (clear summary, mark unnecessary, release the
      // claim).
      const original = "A";

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-apply-empty",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Apply empty",
        content: original,
        summaryStarted: published,
        published,
        updated: published,
      });

      const content = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(content != null);

      // The whitespace-only string is in the same situation: trimmed it
      // is empty, so persisting it would only show stray whitespace.
      await applyArticleContentSummary(tx, content, "   \n\t  ");

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summary, null);
      assert.equal(after?.summaryUnnecessary, true);
      assert.equal(after?.summaryStarted, null);
    });
  },
);

test(
  "applyArticleContentSummary() counts grapheme clusters, not UTF-16 units",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summarycp",
        name: "Summary CP",
        email: "summarycp@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");
      // Each emoji is one grapheme cluster but two UTF-16 code units.
      // The "abc" summary is 3 graphemes and 3 code units; "😀😀" is
      // 4 code units but only 2 graphemes.  By UTF-16 length the
      // summary would look shorter (3 < 4), but in graphemes it is
      // longer (3 >= 2), so the discard path must trigger.
      const content = "😀😀";
      const summary = "abc";

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-cp",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Code points",
        content,
        summaryStarted: published,
        published,
        updated: published,
      });

      const row = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(row != null);

      await applyArticleContentSummary(tx, row, summary);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summary, null);
      assert.equal(after?.summaryUnnecessary, true);
    });
  },
);

test(
  "applyArticleContentSummary() compares summaries against visible content " +
    "outside details blocks",
  async () => {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "summarydetails",
        name: "Summary Details",
        email: "summarydetails@example.com",
      });
      const sourceId = generateUuidV7();
      const published = new Date("2026-04-15T00:00:00.000Z");
      const content = [
        "Visible.",
        "",
        "<details>",
        "<summary>Answer</summary>",
        "This hidden answer is intentionally much longer than the visible " +
        "question text and must not make an otherwise too-long summary look " +
        "acceptable.",
        "</details>",
      ].join("\n");
      const summary = "Visible plus extra.";

      await tx.insert(articleSourceTable).values({
        id: sourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "summary-details",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });
      await tx.insert(articleContentTable).values({
        sourceId,
        language: "en",
        title: "Details",
        content,
        summaryStarted: published,
        published,
        updated: published,
      });

      const row = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.ok(row != null);

      await applyArticleContentSummary(tx, row, summary);

      const after = await tx.query.articleContentTable.findFirst({
        where: { sourceId, language: "en" },
      });
      assert.equal(after?.summary, null);
      assert.equal(after?.summaryUnnecessary, true);
      assert.equal(after?.summaryStarted, null);
    });
  },
);
