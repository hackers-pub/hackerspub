import assert from "node:assert/strict";
import test from "node:test";
import { extractMentionsFromHtml, renderMarkup } from "./markup.ts";
import {
  createFedCtx,
  createTestKv,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

test("renderMarkup() renders title, toc, hashtags, and caches results", async () => {
  const { kv, store } = createTestKv();
  const markup = `# Hello World

## Section Title

Welcome to #HackersPub.`;

  const first = await renderMarkup(null, markup, {
    kv: kv as never,
    docId: "doc-1",
  });

  assert.equal(first.title, "Hello World");
  assert.deepEqual(first.hashtags, ["#HackersPub"]);
  assert.match(first.html, /<h1/);
  assert.equal(first.toc[0].title.trim(), "Hello World");
  assert.equal(first.toc[0].children[0].title.trim(), "Section Title");
  assert.equal(store.size, 1);

  const second = await renderMarkup(null, markup, {
    kv: kv as never,
    docId: "doc-1",
  });

  assert.deepEqual(second, first);
});

test("extractMentionsFromHtml() resolves persisted actor mentions by href", async () => {
  await withRollback(async (tx) => {
    const fedCtx = createFedCtx(tx);
    const actor = await insertRemoteActor(tx, {
      username: "mentionee",
      name: "Mentionee",
      host: "remote.example",
      iri: "https://remote.example/users/mentionee",
    });

    const mentions = await extractMentionsFromHtml(
      fedCtx,
      `<p><a class="mention" href="${actor.iri}">@mentionee</a></p>`,
    );

    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].actor.id, actor.id);
  });
});
