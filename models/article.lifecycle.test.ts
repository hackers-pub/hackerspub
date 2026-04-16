import assert from "node:assert/strict";
import test from "node:test";
import { createArticle, updateArticle } from "./article.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  withRollback,
} from "../test/postgres.ts";

const fakeModels = {
  summarizer: {} as never,
  translator: {} as never,
};

test("createArticle() creates a post and timeline entry for the author", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.data.models = fakeModels as typeof fedCtx.data.models;
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

test("updateArticle() rewrites the persisted article post", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    fedCtx.data.models = fakeModels as typeof fedCtx.data.models;
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

    const storedPost = await tx.query.postTable.findFirst({
      where: { id: article.id },
    });
    assert.ok(storedPost != null);
    assert.equal(storedPost.articleSourceId, article.articleSource.id);
    assert.equal(storedPost.name, "Updated article");
    assert.match(storedPost.contentHtml, /<strong>body<\/strong>/);
  });
});
