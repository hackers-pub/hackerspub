import assert from "node:assert/strict";
import test from "node:test";
import {
  createArticleSource,
  getArticleSource,
  getOriginalArticleContent,
  updateArticleSource,
} from "./article.ts";
import { updateAccountData } from "./account.ts";
import {
  articleContentTable,
  articleSourceTable,
  type NewPost,
  postTable,
} from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import { insertAccountWithActor, withRollback } from "../test/postgres.ts";

const fakeModels = {
  summarizer: {} as never,
  translator: {} as never,
};

test("createArticleSource() creates a source and initial content", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "articlesourceowner",
      name: "Article Source Owner",
      email: "articlesourceowner@example.com",
    });
    const published = new Date("2026-04-15T00:00:00.000Z");

    const source = await createArticleSource(tx, fakeModels, {
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "source-test",
      tags: ["relay"],
      allowLlmTranslation: false,
      published,
      updated: published,
      title: "Original title",
      content: "Original content",
      language: "en",
    });

    assert.ok(source != null);
    assert.equal(source.accountId, author.account.id);
    assert.equal(source.slug, "source-test");
    assert.equal(source.contents.length, 1);
    assert.equal(source.contents[0].language, "en");
    assert.equal(source.contents[0].title, "Original title");
    assert.equal(source.contents[0].content, "Original content");

    const storedContents = await tx.query.articleContentTable.findMany({
      where: { sourceId: source.id },
      orderBy: { published: "asc" },
    });
    assert.equal(storedContents.length, 1);
    assert.equal(storedContents[0].title, "Original title");
  });
});

test("getOriginalArticleContent() picks the earliest non-translation content", () => {
  const sourceId = generateUuidV7();
  const original = {
    sourceId,
    language: "en",
    title: "Original",
    summary: null,
    summaryStarted: null,
    content: "Original body",
    ogImageKey: null,
    originalLanguage: null,
    translatorId: null,
    translationRequesterId: null,
    beingTranslated: false,
    updated: new Date("2026-04-15T00:00:00.000Z"),
    published: new Date("2026-04-15T00:00:00.000Z"),
  };
  const newerOriginal = {
    ...original,
    language: "fr",
    title: "Second original",
    published: new Date("2026-04-15T01:00:00.000Z"),
  };
  const translation = {
    ...original,
    language: "ko",
    title: "Translated",
    originalLanguage: "en",
    translationRequesterId: generateUuidV7(),
  };

  const selected = getOriginalArticleContent({
    id: sourceId,
    accountId: generateUuidV7(),
    publishedYear: 2026,
    slug: "original-content",
    tags: [],
    allowLlmTranslation: false,
    updated: new Date("2026-04-15T00:00:00.000Z"),
    published: new Date("2026-04-15T00:00:00.000Z"),
    contents: [translation, newerOriginal, original],
  });

  assert.deepEqual(selected, original);
});

test("updateArticleSource() updates the original content and preserves translations", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "updatearticlesource",
      name: "Update Article Source",
      email: "updatearticlesource@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "update-source",
      tags: ["solid"],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values([
      {
        sourceId,
        language: "en",
        title: "Original title",
        content: "Original content",
        published,
        updated: published,
      },
      {
        sourceId,
        language: "ko",
        title: "Translated title",
        content: "Translated content",
        originalLanguage: "en",
        translationRequesterId: author.account.id,
        beingTranslated: false,
        published: new Date("2026-04-15T01:00:00.000Z"),
        updated: new Date("2026-04-15T01:00:00.000Z"),
      },
    ]);

    const updated = await updateArticleSource(tx, sourceId, {
      title: "Updated title",
      content: "Updated content",
      slug: "updated-source",
    });

    assert.ok(updated != null);
    assert.equal(updated.slug, "updated-source");
    assert.equal(updated.contents.length, 2);

    const originalContent = updated.contents.find((content) =>
      content.originalLanguage == null
    );
    const translatedContent = updated.contents.find((content) =>
      content.originalLanguage === "en"
    );

    assert.ok(originalContent != null);
    assert.equal(originalContent.title, "Updated title");
    assert.equal(originalContent.content, "Updated content");
    assert.ok(translatedContent != null);
    assert.equal(translatedContent.title, "Translated title");
    assert.equal(translatedContent.content, "Translated content");
  });
});

test("getArticleSource() resolves renamed usernames and returns ordered contents", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "oldarticleuser",
      name: "Old Article User",
      email: "oldarticleuser@example.com",
    });
    const sourceId = generateUuidV7();
    const published = new Date("2026-04-15T00:00:00.000Z");

    await tx.insert(articleSourceTable).values({
      id: sourceId,
      accountId: author.account.id,
      publishedYear: 2026,
      slug: "ordered-article",
      tags: [],
      allowLlmTranslation: false,
      published,
      updated: published,
    });
    await tx.insert(articleContentTable).values([
      {
        sourceId,
        language: "ko",
        title: "Second title",
        content: "Second body",
        published: new Date("2026-04-15T01:00:00.000Z"),
        updated: new Date("2026-04-15T01:00:00.000Z"),
      },
      {
        sourceId,
        language: "en",
        title: "First title",
        content: "First body",
        published,
        updated: published,
      },
    ]);
    await tx.insert(postTable).values(
      {
        id: generateUuidV7(),
        iri: `http://localhost/objects/${sourceId}`,
        type: "Article",
        visibility: "public",
        actorId: author.actor.id,
        articleSourceId: sourceId,
        name: "First title",
        contentHtml: "<p>First body</p>",
        language: "en",
        tags: {},
        emojis: {},
        url:
          `http://localhost/@${author.account.username}/2026/ordered-article`,
        published,
        updated: published,
      } satisfies NewPost,
    );

    const renamed = await updateAccountData(tx, {
      id: author.account.id,
      username: "newarticleuser",
    });
    assert.ok(renamed != null);

    const source = await getArticleSource(
      tx,
      "oldarticleuser",
      2026,
      "ordered-article",
      undefined,
    );

    assert.ok(source != null);
    assert.equal(source.account.username, "newarticleuser");
    assert.deepEqual(
      source.contents.map((content) => content.language),
      ["en", "ko"],
    );
    assert.equal(source.post.actor.id, author.actor.id);
    assert.equal(source.post.articleSourceId, sourceId);
  });
});
