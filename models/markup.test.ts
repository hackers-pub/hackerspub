import assert from "node:assert/strict";
import test from "node:test";
import {
  extractMentionsFromHtml,
  getMissingArticleMediumLabel,
  renderMarkup,
} from "./markup.ts";
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

test("renderMarkup() renders unresolved medium references as an SVG placeholder", async () => {
  const rendered = await renderMarkup(null, "![missing](hp-medium:elsewhere)", {
    missingMediumLabel: getMissingArticleMediumLabel("ko-KR"),
  });

  assert.doesNotMatch(rendered.html, /hp-medium:elsewhere/);
  const src = rendered.html.match(/\bsrc="([^"]+)"/)?.[1];
  assert.ok(src != null);
  assert.ok(src.startsWith("data:image/svg+xml;charset=UTF-8,"));
  const svg = decodeURIComponent(src.slice(src.indexOf(",") + 1));
  assert.match(svg, /이 게시글에 첨부된 적 없는 미디어입니다\./);
});

test("renderMarkup() renders unresolved medium links as an SVG placeholder", async () => {
  const rendered = await renderMarkup(null, "[missing](hp-medium:elsewhere)");

  assert.doesNotMatch(rendered.html, /hp-medium:elsewhere/);
  const href = rendered.html.match(/\bhref="([^"]+)"/)?.[1];
  assert.ok(href != null);
  assert.ok(href.startsWith("data:image/svg+xml;charset=UTF-8,"));
});

test("renderMarkup() resolves medium references in srcset attributes", async () => {
  const rendered = await renderMarkup(
    null,
    `<picture><source srcset="hp-medium:small 1x, hp-medium:large 2x"><img src="hp-medium:small" alt="ok"></picture>`,
    {
      mediumUrls: {
        small: "https://cdn.example/small.webp",
        large: "https://cdn.example/large.webp",
      },
    },
  );

  assert.match(
    rendered.html,
    /srcset="https:\/\/cdn\.example\/small\.webp 1x, https:\/\/cdn\.example\/large\.webp 2x"/,
  );
  assert.match(rendered.html, /src="https:\/\/cdn\.example\/small\.webp"/);
});

test("renderMarkup() uses attached medium URLs when a mapping exists", async () => {
  const rendered = await renderMarkup(null, "![ok](hp-medium:local-key)", {
    mediumUrls: { "local-key": "https://cdn.example/media.webp" },
  });

  assert.match(rendered.html, /https:\/\/cdn\.example\/media\.webp/);
  assert.doesNotMatch(rendered.html, /data:image\/svg\+xml/);
});

test("renderMarkup() does not allow user-authored data URL markdown images", async () => {
  const rendered = await renderMarkup(
    null,
    "![bad](data:image/svg+xml;charset=UTF-8,%3Csvg%20width%3D%221200%22%20height%3D%22675%22%20aria-labelledby%3D%22title%20desc%22%3E%3C/svg%3E)",
  );

  assert.doesNotMatch(rendered.html, /\bsrc="data:image\/svg\+xml/);
  assert.match(rendered.html, /!\[bad\]/);
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
