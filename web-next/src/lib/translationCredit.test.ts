import assert from "node:assert";
import test from "node:test";

import {
  articleAuthorAccountIds,
  articleLanguageMenuRows,
  articleTranslationPresentation,
  automaticTranslationLocales,
  findOriginalContent,
  remoteTranslationCredit,
  remoteTranslationFreshness,
  translationCredit,
  translationFreshness,
} from "./translationCredit.ts";

const AUTHOR = {
  id: "account:author",
  username: "author",
  handle: "@author@h",
};
const MEMBER = {
  id: "account:member",
  username: "member",
  handle: "@member@h",
};
const OTHER = { id: "account:other", username: "other", handle: "@other@h" };

const personalAuthors = articleAuthorAccountIds({ account: { id: AUTHOR.id } });

test("the original-language version carries no translation credit", () => {
  assert.deepEqual(
    translationCredit(
      { originalLanguage: null, provenance: null, translator: null },
      personalAuthors,
    ),
    { kind: "original" },
  );
  // A row is the original because `originalLanguage` is null, not because it
  // happens to have no provenance or translator.
  assert.deepEqual(
    translationCredit(
      { originalLanguage: null, provenance: "HUMAN", translator: AUTHOR },
      personalAuthors,
    ),
    { kind: "original" },
  );
});

test("an automatic translation is never credited to a person", () => {
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: "LLM", translator: null },
      personalAuthors,
    ),
    { kind: "automatic" },
  );
  // Even if a translator somehow accompanied an `LLM` row, the provenance wins:
  // an unreviewed machine translation must not read as human work.
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: "LLM", translator: OTHER },
      personalAuthors,
    ),
    { kind: "automatic" },
  );
});

test("a human translation by the author is credited to the author", () => {
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: "HUMAN", translator: AUTHOR },
      personalAuthors,
    ),
    { kind: "author", assistance: "none" },
  );
});

test("a human translation by someone else is credited by account", () => {
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: "HUMAN", translator: OTHER },
      personalAuthors,
    ),
    { kind: "account", assistance: "none", account: OTHER },
  );
});

test("an AI-assisted translation keeps its credit and its assistance", () => {
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: "LLM_REVIEWED", translator: OTHER },
      personalAuthors,
    ),
    { kind: "account", assistance: "llm", account: OTHER },
  );
  assert.deepEqual(
    translationCredit(
      {
        originalLanguage: "en",
        provenance: "LLM_REVIEWED",
        translator: AUTHOR,
      },
      personalAuthors,
    ),
    { kind: "author", assistance: "llm" },
  );
});

test("a deleted translator does not relabel human work as automatic", () => {
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: "HUMAN", translator: null },
      personalAuthors,
    ),
    { kind: "unavailable", assistance: "none" },
  );
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: "LLM_REVIEWED", translator: null },
      personalAuthors,
    ),
    { kind: "unavailable", assistance: "llm" },
  );
});

test("unknown provenance keeps a credit but claims no method", () => {
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: "UNKNOWN", translator: OTHER },
      personalAuthors,
    ),
    { kind: "account", assistance: "unknown", account: OTHER },
  );
  // Nothing is known and nobody is credited: do not invent a deleted account.
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: "UNKNOWN", translator: null },
      personalAuthors,
    ),
    { kind: "unknown" },
  );
});

test("an unrecognized provenance never reads as human, AI-assisted, or automatic", () => {
  // Relay generates `"%future added value"` into every enum union, and the
  // schema may gain members later; neither may acquire a label by accident.
  for (const provenance of ["%future added value", "MACHINE_POST_EDITED"]) {
    assert.deepEqual(
      translationCredit(
        { originalLanguage: "en", provenance, translator: OTHER },
        personalAuthors,
      ),
      { kind: "account", assistance: "unknown", account: OTHER },
    );
    assert.deepEqual(
      translationCredit(
        { originalLanguage: "en", provenance, translator: null },
        personalAuthors,
      ),
      { kind: "unknown" },
    );
  }
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "en", provenance: null, translator: null },
      personalAuthors,
    ),
    { kind: "unknown" },
  );
});

test("an organization co-author counts as the author only when displayed", () => {
  const coauthored = articleAuthorAccountIds({
    account: { id: "account:org" },
    organizationAuthor: {
      attributionMode: "ACTING_ACCOUNT_WITH_VIEWER",
      member: { id: MEMBER.id },
    },
  });
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "ko", provenance: "HUMAN", translator: MEMBER },
      coauthored,
    ),
    { kind: "author", assistance: "none" },
  );

  // `ACTING_ACCOUNT_ONLY` never presents the member as an author, so their
  // translation is credited by handle rather than as "the author".
  const organizationOnly = articleAuthorAccountIds({
    account: { id: "account:org" },
    organizationAuthor: {
      attributionMode: "ACTING_ACCOUNT_ONLY",
      member: { id: MEMBER.id },
    },
  });
  assert.deepEqual(
    translationCredit(
      { originalLanguage: "ko", provenance: "HUMAN", translator: MEMBER },
      organizationOnly,
    ),
    { kind: "account", assistance: "none", account: MEMBER },
  );
  assert.deepEqual([...organizationOnly], ["account:org"]);
});

test("author account ids tolerate a remote article with no local account", () => {
  assert.deepEqual([...articleAuthorAccountIds({})], []);
  assert.deepEqual([...articleAuthorAccountIds({ account: null })], []);
  assert.deepEqual(
    [
      ...articleAuthorAccountIds({
        account: { id: "account:org" },
        organizationAuthor: {
          attributionMode: "ACTING_ACCOUNT_WITH_VIEWER",
          member: null,
        },
      }),
    ],
    ["account:org"],
  );
});

test("an unfinished automatic translation is not credited as a version", () => {
  // The placeholder row carries `provenance: LLM` and a copy of the original's
  // text, so calling it an automatic translation would promise a reader a
  // translated version that does not exist yet.
  assert.deepEqual(
    translationCredit(
      {
        originalLanguage: "en",
        provenance: "LLM",
        translator: null,
        beingTranslated: true,
      },
      personalAuthors,
    ),
    { kind: "translating" },
  );
});

test("freshness does not apply to the original or to an in-flight translation", () => {
  assert.equal(
    translationFreshness({ originalLanguage: null, reviewState: null }),
    null,
  );
  assert.equal(
    translationFreshness({
      originalLanguage: "en",
      reviewState: "NEEDS_REVIEW",
      beingTranslated: true,
    }),
    null,
  );
});

test("freshness reports a known source change and an unverified baseline apart", () => {
  assert.equal(
    translationFreshness({ originalLanguage: "en", reviewState: "CURRENT" }),
    "current",
  );
  assert.equal(
    translationFreshness({
      originalLanguage: "en",
      reviewState: "NEEDS_REVIEW",
    }),
    "source-changed",
  );
  assert.equal(
    translationFreshness({
      originalLanguage: "en",
      reviewState: "UNKNOWN_BASELINE",
    }),
    "unverified",
  );
});

test("an unrecorded review state never reads as a known source change", () => {
  for (const reviewState of [null, undefined, "%future added value"]) {
    assert.equal(
      translationFreshness({ originalLanguage: "en", reviewState }),
      "unverified",
    );
  }
});

test("the original version is found by its null originalLanguage", () => {
  const original = { language: "en", originalLanguage: null, url: "u/en" };
  const translation = { language: "ko", originalLanguage: "en", url: "u/ko" };
  assert.equal(
    findOriginalContent([translation, null, original, undefined]),
    original,
  );
  // The `[lang]` route filters `contents` to one translated row, so the
  // original is not always in the returned set; callers fall back themselves.
  assert.equal(findOriginalContent([translation]), null);
  assert.equal(findOriginalContent([]), null);
  assert.equal(findOriginalContent(null), null);
});

const ORIGINAL_ROW = {
  language: "en",
  originalLanguage: null,
  provenance: null,
  reviewState: null,
  url: "https://example.com/@author/2026/post",
};
const KOREAN_ROW = {
  language: "ko",
  originalLanguage: "en",
  provenance: "HUMAN",
  reviewState: "NEEDS_REVIEW",
  translator: OTHER,
  url: "https://example.com/@author/2026/post/ko",
};
const personalArticle = { account: { id: AUTHOR.id } };

test("the presentation of the original carries no credit, notice, or edit link", () => {
  const presentation = articleTranslationPresentation({
    content: ORIGINAL_ROW,
    allContents: [ORIGINAL_ROW, KOREAN_ROW],
    article: personalArticle,
    articleBase: "/@author/2026/post",
    viewerCanManageTranslations: true,
  });
  assert.deepEqual(presentation.credit, { kind: "original" });
  assert.equal(presentation.freshness, null);
  assert.equal(presentation.editTranslationHref, null);
  assert.equal(presentation.editTargetIsOriginal, false);
});

test("a stale translation warns and links to the original's own URL", () => {
  const presentation = articleTranslationPresentation({
    content: KOREAN_ROW,
    allContents: [ORIGINAL_ROW, KOREAN_ROW],
    article: personalArticle,
    articleBase: "/@author/2026/post",
    viewerCanManageTranslations: false,
  });
  assert.deepEqual(presentation.credit, {
    kind: "account",
    assistance: "none",
    account: OTHER,
  });
  assert.equal(presentation.freshness, "source-changed");
  assert.equal(presentation.originalUrl, ORIGINAL_ROW.url);
  assert.equal(presentation.originalPath, "/@author/2026/post");
  // Editing is gated on article permission, not on translator credit.
  assert.equal(presentation.editTranslationHref, null);
  assert.equal(presentation.editTargetIsOriginal, true);
});

test("the original link falls back to the article URL when its row is filtered out", () => {
  // The `[lang]` route negotiates `contents` down to the requested row, so the
  // original is often not in the returned set.
  const presentation = articleTranslationPresentation({
    content: KOREAN_ROW,
    allContents: [KOREAN_ROW],
    article: personalArticle,
    articleBase: "/@author/2026/post",
    articleUrl: "https://example.com/@author/2026/post",
    viewerCanManageTranslations: false,
  });
  assert.equal(
    presentation.originalUrl,
    "https://example.com/@author/2026/post",
  );
  assert.equal(presentation.originalPath, "/@author/2026/post");
});

test("an authorized viewer gets an editor link for the displayed language", () => {
  const presentation = articleTranslationPresentation({
    content: { ...KOREAN_ROW, language: "zh-TW" },
    allContents: [ORIGINAL_ROW],
    article: personalArticle,
    articleBase: "/@author/2026/post",
    viewerCanManageTranslations: true,
  });
  assert.equal(
    presentation.editTranslationHref,
    "/@author/2026/post/translations?language=zh-TW",
  );
  assert.equal(presentation.editTargetIsOriginal, true);
});

test("a remote article with no local path offers no editor link", () => {
  const presentation = articleTranslationPresentation({
    content: KOREAN_ROW,
    allContents: [ORIGINAL_ROW],
    article: {},
    articleBase: null,
    viewerCanManageTranslations: true,
  });
  assert.equal(presentation.editTranslationHref, null);
});

test("the language menu marks the current row and describes the others", () => {
  const rows = articleLanguageMenuRows({
    allContents: [
      ORIGINAL_ROW,
      KOREAN_ROW,
      {
        language: "ja",
        originalLanguage: "en",
        provenance: "LLM",
        reviewState: "UNKNOWN_BASELINE",
        url: "https://example.com/@author/2026/post/ja",
      },
      null,
    ],
    article: personalArticle,
    currentLanguage: "ko",
    articleBase: "/@author/2026/post",
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    language: "en",
    href: ORIGINAL_ROW.url,
    current: false,
    beingTranslated: false,
    credit: { kind: "original" },
    freshness: null,
  });
  // The row being read is listed but is not a link to itself.
  assert.equal(rows[1].current, true);
  assert.equal(rows[1].href, null);
  assert.equal(rows[1].freshness, "source-changed");
  assert.deepEqual(rows[2].credit, { kind: "automatic" });
  assert.equal(rows[2].freshness, "unverified");
});

test("an in-progress automatic translation shows no credit or freshness", () => {
  const rows = articleLanguageMenuRows({
    allContents: [
      {
        language: "ja",
        originalLanguage: "en",
        provenance: "LLM",
        reviewState: "UNKNOWN_BASELINE",
        beingTranslated: true,
        url: null,
      },
    ],
    article: personalArticle,
    currentLanguage: "en",
    articleBase: "/@author/2026/post",
  });
  assert.deepEqual(rows, [
    {
      language: "ja",
      // No server-assigned URL yet, so the canonical language segment is used.
      href: "/@author/2026/post/ja",
      current: false,
      beingTranslated: true,
      credit: { kind: "translating" },
      freshness: null,
    },
  ]);
});

test("a language still being translated offers no credit and no editor link", () => {
  const presentation = articleTranslationPresentation({
    content: {
      language: "ja",
      originalLanguage: "en",
      provenance: "LLM",
      reviewState: "UNKNOWN_BASELINE",
      beingTranslated: true,
      url: null,
    },
    allContents: [ORIGINAL_ROW],
    article: personalArticle,
    articleBase: "/@author/2026/post",
    viewerCanManageTranslations: true,
  });
  assert.deepEqual(presentation.credit, { kind: "translating" });
  assert.equal(presentation.freshness, null);
  // The management page lists published versions and private drafts; an
  // unfinished automatic job is neither, so the link would open nothing.
  assert.equal(presentation.editTranslationHref, null);
  // The generic edit action still opens the original rather than this page.
  assert.equal(presentation.editTargetIsOriginal, true);
});

test("the original link is followed as a real link when it leaves this article", () => {
  // A remote article has no local path, so a client-side navigation to the
  // remote URL's pathname would land somewhere unrelated.
  const remote = articleTranslationPresentation({
    content: KOREAN_ROW,
    allContents: [
      { ...ORIGINAL_ROW, url: "https://remote.example/users/a/posts/1" },
    ],
    article: {},
    articleBase: null,
    viewerCanManageTranslations: false,
  });
  assert.equal(remote.originalUrl, "https://remote.example/users/a/posts/1");
  assert.equal(remote.originalPath, null);

  // A slug the route escapes and the canonical URL does not still names the
  // same page, so it keeps client-side navigation.
  const escapedSlug = articleTranslationPresentation({
    content: KOREAN_ROW,
    allContents: [
      { ...ORIGINAL_ROW, url: "https://example.com/@author/2026/c++" },
    ],
    article: personalArticle,
    articleBase: "/@author/2026/c%2B%2B",
    viewerCanManageTranslations: false,
  });
  assert.equal(escapedSlug.originalPath, "/@author/2026/c%2B%2B");

  // A URL that does not belong to this article is not navigated to either.
  const foreign = articleTranslationPresentation({
    content: KOREAN_ROW,
    allContents: [
      { ...ORIGINAL_ROW, url: "https://example.com/@other/2026/x" },
    ],
    article: personalArticle,
    articleBase: "/@author/2026/post",
    viewerCanManageTranslations: false,
  });
  assert.equal(foreign.originalPath, null);
});

const normalizeLocale = (locale: string) =>
  ["en", "en-US", "ko", "ja", "zh-CN", "zh-TW"].includes(locale)
    ? locale
    : undefined;

test("automatic translation offers skip published, current, and original languages", () => {
  assert.deepEqual(
    automaticTranslationLocales({
      allowLlmTranslation: true,
      viewerLocales: ["ko", "ja", "en-US"],
      articleLanguage: "en",
      currentLanguage: "ko",
      publishedLanguages: ["en", "ko"],
      normalizeLocale,
    }),
    ["ja"],
  );
});

test("automatic translation offers keep script distinctions but collapse regions", () => {
  // `zh-CN` and `zh-TW` maximize to different scripts, so a reader whose
  // locale is Traditional Chinese is still offered it.
  assert.deepEqual(
    automaticTranslationLocales({
      allowLlmTranslation: true,
      viewerLocales: ["zh-TW"],
      articleLanguage: "en",
      currentLanguage: "en",
      publishedLanguages: ["en", "zh-CN"],
      normalizeLocale,
    }),
    ["zh-TW"],
  );
  // `en-US` and `en` share language and script, so the published version
  // already covers the reader's locale.
  assert.deepEqual(
    automaticTranslationLocales({
      allowLlmTranslation: true,
      viewerLocales: ["en-US"],
      articleLanguage: "ko",
      currentLanguage: "ko",
      publishedLanguages: ["ko", "en"],
      normalizeLocale,
    }),
    [],
  );
});

test("automatic translation is not offered when the author disabled it", () => {
  assert.deepEqual(
    automaticTranslationLocales({
      allowLlmTranslation: false,
      viewerLocales: ["ja"],
      articleLanguage: "en",
      currentLanguage: "en",
      publishedLanguages: ["en"],
      normalizeLocale,
    }),
    [],
  );
  // An unsupported content locale would 404 on the `[lang]` route.
  assert.deepEqual(
    automaticTranslationLocales({
      allowLlmTranslation: true,
      viewerLocales: ["fr-CH", "ja"],
      articleLanguage: "en",
      currentLanguage: "en",
      publishedLanguages: ["en"],
      normalizeLocale,
    }),
    ["ja"],
  );
});

const REMOTE_PERSON = {
  id: "actor:carol",
  handle: "@carol@remote.example",
  type: "PERSON",
};
const REMOTE_BOT = {
  id: "actor:bot",
  handle: "@bot@remote.example",
  type: "APPLICATION",
};

test("a remote translation is credited from the publisher's claim", () => {
  assert.deepEqual(
    remoteTranslationCredit({
      kind: "HUMAN",
      freshness: "CURRENT",
      byAuthor: false,
      translators: [REMOTE_PERSON],
    }),
    {
      kind: "account",
      assistance: "none",
      account: {
        id: "actor:carol",
        username: "carol@remote.example",
        handle: "@carol@remote.example",
      },
    },
  );
  // The reviewer of machine output is the person, never the machine.
  assert.deepEqual(
    remoteTranslationCredit({
      kind: "MACHINE_REVIEWED",
      freshness: "CURRENT",
      byAuthor: false,
      translators: [REMOTE_BOT, REMOTE_PERSON],
    }),
    {
      kind: "account",
      assistance: "llm",
      account: {
        id: "actor:carol",
        username: "carol@remote.example",
        handle: "@carol@remote.example",
      },
    },
  );
  assert.deepEqual(
    remoteTranslationCredit({
      kind: "HUMAN",
      freshness: "CURRENT",
      byAuthor: true,
      translators: [REMOTE_PERSON],
    }),
    { kind: "author", assistance: "none" },
  );
  assert.deepEqual(
    remoteTranslationCredit({
      kind: "MACHINE",
      freshness: "UNKNOWN",
      byAuthor: false,
      translators: [REMOTE_BOT],
    }),
    { kind: "automatic" },
  );
});

test("an unresolved or unrecognized remote claim credits nobody", () => {
  for (const kind of ["UNKNOWN", "%future added value"]) {
    assert.deepEqual(
      remoteTranslationCredit({
        kind,
        freshness: "CURRENT",
        byAuthor: false,
        translators: [REMOTE_PERSON],
      }),
      { kind: "unknown" },
    );
  }
  // A human claim whose person is not known here is not presented as an
  // unavailable (deleted) account either.
  assert.deepEqual(
    remoteTranslationCredit({
      kind: "HUMAN",
      freshness: "CURRENT",
      byAuthor: false,
      translators: [],
    }),
    { kind: "unknown" },
  );
});

test("remote freshness never reads an unknown claim as current", () => {
  assert.equal(remoteTranslationFreshness({ freshness: "CURRENT" }), "current");
  assert.equal(
    remoteTranslationFreshness({ freshness: "SOURCE_CHANGED" }),
    "source-changed",
  );
  assert.equal(
    remoteTranslationFreshness({ freshness: "UNKNOWN" }),
    "unverified",
  );
  assert.equal(
    remoteTranslationFreshness({ freshness: "%future added value" }),
    "unverified",
  );
});
