import assert from "node:assert";
import test from "node:test";
import { Article as ActivityPubArticle, Create } from "@fedify/vocab";
import { createArticle, updateArticle } from "./article.ts";
import type { ApplicationContext } from "./context.ts";
import type { Transaction } from "./db.ts";
import {
  articleContentTable,
  mediumTable,
  organizationPostAuthorTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";
import { waitFor } from "../test/wait.ts";

const fakeModels = {
  summarizer: {} as never,
  translator: {} as never,
  moderationAnalyzer: {} as never,
};

test("createArticle() creates a post and timeline entry for the author", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "createarticleauthor",
      name: "Create Article Author",
      email: "createarticleauthor@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");

    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "create-article",
      tags: ["solid"],
      allowLlmTranslation: false,
      published,
      updated: published,
      title: "Article title",
      content: "Hello **article**",
      language: "en",
    });

    assert.ok(article != null);
    assert.equal(article.actor.id, author.actor.id);
    assert.equal(article.articleSource.slug, "create-article");
    assert.equal(article.name, "Article title");
    assert.match(article.contentHtml, /<strong>article<\/strong>/);
    assert.ok(article.linkId != null);
    assert.equal(article.linkUrl, article.url);

    const link = await tx.query.postLinkTable.findFirst({
      where: { id: article.linkId },
    });
    assert.ok(link != null);
    assert.equal(link.url, article.url);
    assert.equal(link.title, "Article title");
    assert.equal(link.type, "article");
    assert.equal(link.creatorId, author.actor.id);
    assert.equal(link.postCount, 1);
    assert.ok(link.latestActivity != null);
    assert.ok(link.scoreUpdated != null);

    const timelineItem = await tx.query.timelineItemTable.findFirst({
      where: {
        accountId: author.account.id,
        postId: article.id,
      },
    });
    assert.ok(timelineItem != null);
    assert.equal(timelineItem.originalAuthorId, author.actor.id);
    assert.equal(timelineItem.lastSharerId, null);
  });
});

test("createArticle() applies post-created hooks before federation", async () => {
  await withRollback(async (tx) => {
    const member = await insertAccountWithActor(tx, {
      username: "createarticlecoauthor",
      name: "Create Article Co-author",
      email: "createarticlecoauthor@example.com",
    });
    const organization = await insertAccountWithActor(tx, {
      username: "createarticleorg",
      name: "Create Article Organization",
      email: "createarticleorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    const sent: unknown[][] = [];
    const fedCtx = {
      ...createFedCtx(tx),
      sendActivity(...args: unknown[]) {
        sent.push(args);
        return Promise.resolve(undefined);
      },
    } as unknown as ApplicationContext<Transaction>;
    fedCtx.models = fakeModels as typeof fedCtx.models;

    const article = await createArticle(
      fedCtx,
      {
        accountId: organization.account.id,
        publishedYear: 2026,
        slug: "co-authored-create-article",
        tags: [],
        allowLlmTranslation: false,
        title: "Co-authored article",
        content: "Hello from an organization.",
        language: "en",
      },
      {
        async afterPostCreated(post) {
          await tx.insert(organizationPostAuthorTable).values({
            postId: post.id,
            organizationAccountId: organization.account.id,
            memberAccountId: member.account.id,
            attributionMode: "acting_account_with_viewer",
          });
        },
      },
    );

    assert.ok(article != null);
    const create = sent
      .map((args) => args[2])
      .find((activity) => activity instanceof Create);
    assert.ok(create instanceof Create);
    assert.deepEqual(
      create.actorIds.map((id) => id.href),
      [`http://localhost/actors/${organization.account.id}`],
    );
    const object = await create.getObject({ ...fedCtx, suppressError: true });
    assert.ok(object instanceof ActivityPubArticle);
    assert.deepEqual(
      object.attributionIds.map((id) => id.href),
      [
        `http://localhost/actors/${organization.account.id}`,
        `http://localhost/actors/${member.account.id}`,
      ],
    );
  });
});

test("createArticle() copies source media before rendering the post", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "createarticlemediaauthor",
      name: "Create Article Media Author",
      email: "createarticlemediaauthor@example.com",
    });
    const mediumId = generateUuidV7();
    await tx.insert(mediumTable).values({
      id: mediumId,
      key: "media/create-article-media.webp",
      type: "image/webp",
      width: 2,
      height: 2,
    });
    const prefixMediumId = generateUuidV7();
    await tx.insert(mediumTable).values({
      id: prefixMediumId,
      key: "media/create-article-prefix.webp",
      type: "image/webp",
      width: 2,
      height: 2,
    });

    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "create-article-media",
      tags: [],
      allowLlmTranslation: false,
      title: "Article with media",
      content: "![Hero](hp-medium:hero)",
      language: "en",
      media: [
        { key: "hero", mediumId },
        { key: "her", mediumId: prefixMediumId },
      ],
    });

    assert.ok(article != null);
    assert.match(
      article.contentHtml,
      /http:\/\/localhost\/media\/media\/create-article-media\.webp/,
    );
    assert.doesNotMatch(article.contentHtml, /hp-medium:hero/);

    const media = await tx.query.articleSourceMediumTable.findFirst({
      where: { articleSourceId: article.articleSource.id, key: "hero" },
    });
    assert.ok(media != null);
    assert.equal(media.mediumId, mediumId);
    const prefixMedia = await tx.query.articleSourceMediumTable.findFirst({
      where: { articleSourceId: article.articleSource.id, key: "her" },
    });
    assert.equal(prefixMedia, undefined);
  });
});

test("createArticle() rejects content with missing source media", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "missingarticlemediaauthor",
      name: "Missing Article Media Author",
      email: "missingarticlemediaauthor@example.com",
    });

    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "missing-article-media",
      tags: [],
      allowLlmTranslation: false,
      title: "Article with missing media",
      content: "![Hero](hp-medium:missing)",
      language: "en",
      media: [],
    });

    assert.equal(article, undefined);
    const source = await tx.query.articleSourceTable.findFirst({
      where: { slug: "missing-article-media" },
    });
    assert.equal(source, undefined);
  });
});

test("updateArticle() rewrites the persisted article post", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "updatearticleauthor",
      name: "Update Article Author",
      email: "updatearticleauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "original-article",
      tags: [],
      allowLlmTranslation: false,
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
      title: "Original article",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const originalLinkId = article.linkId;
    assert.ok(originalLinkId != null);

    const updated = await updateArticle(fedCtx, article.articleSource.id, {
      slug: "updated-article",
      title: "Updated article",
      content: "Updated **body**",
    });

    assert.ok(updated != null);
    assert.equal(updated.id, article.id);
    assert.equal(updated.articleSource.id, article.articleSource.id);
    assert.equal(updated.articleSource.slug, "updated-article");
    assert.equal(updated.name, "Updated article");
    assert.match(updated.contentHtml, /<strong>body<\/strong>/);
    assert.match(updated.url ?? "", /updated-article$/);
    assert.ok(updated.linkId != null);
    assert.notEqual(updated.linkId, originalLinkId);
    assert.equal(updated.linkUrl, updated.url);

    const storedPost = await tx.query.postTable.findFirst({
      where: { id: article.id },
    });
    assert.ok(storedPost != null);
    assert.equal(storedPost.articleSourceId, article.articleSource.id);
    assert.equal(storedPost.name, "Updated article");
    assert.match(storedPost.contentHtml, /<strong>body<\/strong>/);
    assert.equal(storedPost.linkId, updated.linkId);

    const originalLink = await tx.query.postLinkTable.findFirst({
      where: { id: originalLinkId },
    });
    assert.ok(originalLink != null);
    assert.equal(originalLink.latestActivity, null);

    const updatedLink = await tx.query.postLinkTable.findFirst({
      where: { id: updated.linkId },
    });
    assert.ok(updatedLink != null);
    assert.equal(updatedLink.url, updated.url);
    assert.equal(updatedLink.title, "Updated article");
    assert.ok(updatedLink.latestActivity != null);
  });
});

test("updateArticle() notifies local sharers when the title changes", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "updatearticleshareauthor",
      name: "Update Article Share Author",
      email: "updatearticleshareauthor@example.com",
    });
    const sharer = await insertAccountWithActor(tx, {
      username: "updatearticlesharer",
      name: "Update Article Sharer",
      email: "updatearticlesharer@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "article-share-update",
      tags: [],
      allowLlmTranslation: false,
      title: "Original article title",
      content: "Original article body",
      language: "en",
    });
    assert.ok(article != null);
    await insertNotePost(tx, {
      account: sharer.account,
      content: "",
      sharedPostId: article.id,
    });

    await updateArticle(fedCtx, article.articleSource.id, {
      title: "Updated article title",
    });

    const notification = await tx.query.notificationTable.findFirst({
      where: {
        accountId: sharer.account.id,
        type: "shared_post_updated",
        postId: article.id,
      },
    });
    assert.ok(notification != null);
    assert.deepEqual(notification.actorIds, [author.actor.id]);
  });
});

test("updateArticle() attaches source media before rendering the post", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "updatearticlemediaauthor",
      name: "Update Article Media Author",
      email: "updatearticlemediaauthor@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "update-article-media",
      tags: [],
      allowLlmTranslation: false,
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
      title: "Original article",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    const mediumId = generateUuidV7();
    await tx.insert(mediumTable).values({
      id: mediumId,
      key: "media/update-article-media.webp",
      type: "image/webp",
      width: 2,
      height: 2,
    });

    const updated = await updateArticle(fedCtx, article.articleSource.id, {
      content: "![Hero](hp-medium:hero)",
      media: [{ key: "hero", mediumId }],
    });

    assert.ok(updated != null);
    assert.match(
      updated.contentHtml,
      /http:\/\/localhost\/media\/media\/update-article-media\.webp/,
    );
    assert.doesNotMatch(updated.contentHtml, /hp-medium:hero/);

    const relation = await tx.query.articleSourceMediumTable.findFirst({
      where: { articleSourceId: article.articleSource.id, key: "hero" },
    });
    assert.ok(relation != null);
    assert.equal(relation.mediumId, mediumId);
  });
});

test("updateArticle() rejects missing source media without saving content", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "updatearticlemissingmedia",
      name: "Update Article Missing Media",
      email: "updatearticlemissingmedia@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "update-article-missing-media",
      tags: [],
      allowLlmTranslation: false,
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
      title: "Original article",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);

    const updated = await updateArticle(fedCtx, article.articleSource.id, {
      content: "![Missing](hp-medium:missing)",
      media: [],
    });

    assert.equal(updated, undefined);
    const originalContent = await tx.query.articleContentTable.findFirst({
      where: {
        sourceId: article.articleSource.id,
        originalLanguage: { isNull: true },
      },
    });
    assert.ok(originalContent != null);
    assert.equal(originalContent.content, "Original body");
  });
});

test("updateArticle() resets existing translation rows when the body changes", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "retranslateauthor",
      name: "Retranslate Author",
      email: "retranslateauthor@example.com",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "retranslaterequester",
      name: "Retranslate Requester",
      email: "retranslaterequester@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "retranslate-article",
      tags: [],
      allowLlmTranslation: true,
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
      title: "Original article",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    // Pre-existing completed translation row that the edit should
    // invalidate.
    await tx.insert(articleContentTable).values({
      sourceId: article.articleSource.id,
      language: "ko",
      title: "Old translated title",
      content: "Old translated body",
      summary: "Old summary.",
      originalLanguage: "en",
      translationRequesterId: requester.account.id,
      beingTranslated: false,
      published: new Date("2026-04-15T01:00:00.000Z"),
      updated: new Date("2026-04-15T01:00:00.000Z"),
    });

    const updated = await updateArticle(fedCtx, article.articleSource.id, {
      content: "Edited body",
    });
    assert.ok(updated != null);

    // The retranslation runs in the background.  The placeholder
    // reset is awaited synchronously, then the failing stub
    // translator deletes the row via the failure-cleanup branch.
    // Either observable is acceptable.
    await waitFor(async () => {
      const ko = await tx.query.articleContentTable.findFirst({
        where: { sourceId: article.articleSource.id, language: "ko" },
      });
      if (ko == null) return true;
      return (
        ko.beingTranslated === true &&
        ko.title === "Original article" &&
        ko.content === "Edited body" &&
        ko.summary === null
      );
    });
  });
});

test("updateArticle() leaves existing translations alone on title-only edits", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "retranslatetitleauthor",
      name: "Retranslate Title Author",
      email: "retranslatetitleauthor@example.com",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "retranslatetitlerequester",
      name: "Retranslate Title Requester",
      email: "retranslatetitlerequester@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "retranslate-title-article",
      tags: [],
      allowLlmTranslation: true,
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
      title: "Original article",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    await tx.insert(articleContentTable).values({
      sourceId: article.articleSource.id,
      language: "ko",
      title: "Existing translated title",
      content: "Existing translated body",
      summary: "Existing summary.",
      originalLanguage: "en",
      translationRequesterId: requester.account.id,
      beingTranslated: false,
      published: new Date("2026-04-15T01:00:00.000Z"),
      updated: new Date("2026-04-15T01:00:00.000Z"),
    });

    const updated = await updateArticle(fedCtx, article.articleSource.id, {
      title: "Renamed only",
    });
    assert.ok(updated != null);

    // Title-only edits don't trigger retranslation; the ko row stays
    // exactly as it was — no placeholder, no deletion, original
    // summary preserved.
    const ko = await tx.query.articleContentTable.findFirst({
      where: { sourceId: article.articleSource.id, language: "ko" },
    });
    assert.ok(ko != null);
    assert.equal(ko.beingTranslated, false);
    assert.equal(ko.title, "Existing translated title");
    assert.equal(ko.content, "Existing translated body");
    assert.equal(ko.summary, "Existing summary.");
  });
});

test("updateArticle() does not retranslate when allowLlmTranslation is false", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "noretranslateauthor",
      name: "No Retranslate Author",
      email: "noretranslateauthor@example.com",
    });
    const requester = await insertAccountWithActor(tx, {
      username: "noretranslaterequester",
      name: "No Retranslate Requester",
      email: "noretranslaterequester@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "no-retranslate-article",
      tags: [],
      // The author opted out of LLM translation: no placeholder
      // resets, no background `translate()` calls.  This guards
      // against re-enqueueing translation work in the same edit
      // that flips the switch off (or any later body edit while
      // the switch stays off).
      allowLlmTranslation: false,
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
      title: "Original article",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    // A pre-existing translation row from before the switch was
    // turned off (or seeded by a prior allowLlmTranslation=true
    // window) — must remain unchanged.
    await tx.insert(articleContentTable).values({
      sourceId: article.articleSource.id,
      language: "ko",
      title: "Existing translated title",
      content: "Existing translated body",
      summary: "Existing summary.",
      originalLanguage: "en",
      translationRequesterId: requester.account.id,
      beingTranslated: false,
      published: new Date("2026-04-15T01:00:00.000Z"),
      updated: new Date("2026-04-15T01:00:00.000Z"),
    });

    const updated = await updateArticle(fedCtx, article.articleSource.id, {
      content: "Edited body",
    });
    assert.ok(updated != null);

    // No placeholder reset, no `translate()` queued: the row
    // stays exactly as it was.  No async waiting needed because
    // the gate skips the synchronous claim-and-reset entirely.
    const ko = await tx.query.articleContentTable.findFirst({
      where: { sourceId: article.articleSource.id, language: "ko" },
    });
    assert.ok(ko != null);
    assert.equal(ko.beingTranslated, false);
    assert.equal(ko.title, "Existing translated title");
    assert.equal(ko.content, "Existing translated body");
    assert.equal(ko.summary, "Existing summary.");
  });
});

test("updateArticle() does not retranslate human-curated translation rows", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.models = fakeModels as typeof fedCtx.models;
    const author = await insertAccountWithActor(tx, {
      username: "humantranslateauthor",
      name: "Human Translate Author",
      email: "humantranslateauthor@example.com",
    });
    const humanTranslator = await insertAccountWithActor(tx, {
      username: "humantranslator",
      name: "Human Translator",
      email: "humantranslator@example.com",
    });
    const llmRequester = await insertAccountWithActor(tx, {
      username: "humantranslatellmrequester",
      name: "LLM Requester",
      email: "humantranslatellmrequester@example.com",
    });
    const article = await createArticle(fedCtx, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "human-translate-article",
      tags: [],
      allowLlmTranslation: true,
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
      title: "Original article",
      content: "Original body",
      language: "en",
    });
    assert.ok(article != null);
    // A human-curated translation row: `translatorId` is set
    // (and `translationRequesterId` is null per the schema check
    // `article_content_translator_translation_requester_id_check`,
    // which makes the two columns mutually exclusive).  This row
    // must survive a body edit untouched: resetting it to a
    // source-language placeholder for the LLM to re-do would
    // silently destroy the translator's work.
    await tx.insert(articleContentTable).values({
      sourceId: article.articleSource.id,
      language: "ko",
      title: "Human-curated translated title",
      content: "Human-curated translated body",
      summary: "Human-curated summary.",
      originalLanguage: "en",
      translatorId: humanTranslator.account.id,
      translationRequesterId: null,
      beingTranslated: false,
      published: new Date("2026-04-15T01:00:00.000Z"),
      updated: new Date("2026-04-15T01:00:00.000Z"),
    });
    // An LLM-requested translation row alongside it, to confirm
    // the gate is selective rather than blanket-skipping the
    // restart for the whole article.
    await tx.insert(articleContentTable).values({
      sourceId: article.articleSource.id,
      language: "ja",
      title: "LLM translated title",
      content: "LLM translated body",
      summary: "LLM summary.",
      originalLanguage: "en",
      translatorId: null,
      translationRequesterId: llmRequester.account.id,
      beingTranslated: false,
      published: new Date("2026-04-15T01:00:00.000Z"),
      updated: new Date("2026-04-15T01:00:00.000Z"),
    });

    const updated = await updateArticle(fedCtx, article.articleSource.id, {
      content: "Edited body",
    });
    assert.ok(updated != null);

    // Human row stays exactly as it was.
    const ko = await tx.query.articleContentTable.findFirst({
      where: { sourceId: article.articleSource.id, language: "ko" },
    });
    assert.ok(ko != null);
    assert.equal(ko.beingTranslated, false);
    assert.equal(ko.title, "Human-curated translated title");
    assert.equal(ko.content, "Human-curated translated body");
    assert.equal(ko.summary, "Human-curated summary.");
    assert.equal(ko.translatorId, humanTranslator.account.id);

    // The LLM row, in contrast, IS picked up by the restart and
    // ends up either as a placeholder (which the failing stub
    // translator then deletes) or already deleted by the
    // failure-cleanup path.
    await waitFor(async () => {
      const ja = await tx.query.articleContentTable.findFirst({
        where: { sourceId: article.articleSource.id, language: "ja" },
      });
      if (ja == null) return true;
      return (
        ja.beingTranslated === true &&
        ja.title === "Original article" &&
        ja.content === "Edited body"
      );
    });
  });
});
