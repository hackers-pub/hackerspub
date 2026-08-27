import assert from "node:assert";
import test from "node:test";
import {
  articlePageLocationChanged,
  getArticleViewReferrerHostname,
} from "./articleViewReferrer.ts";

test("article referrers preserve the initial document referrer", () => {
  assert.equal(
    getArticleViewReferrerHostname({
      documentReferrer: "https://www.google.com/search?q=article",
      currentUrl: "https://hackers.pub/@alice/2026/article",
      initialDocumentUrl: "https://hackers.pub/@alice/2026/article",
      clientNavigationSeen: false,
    }),
    "www.google.com",
  );
});

test("article referrers classify client navigation as internal", () => {
  assert.equal(
    getArticleViewReferrerHostname({
      documentReferrer: "https://www.google.com/search?q=article",
      currentUrl: "https://hackers.pub/@alice/2026/article",
      initialDocumentUrl: "https://hackers.pub/",
      clientNavigationSeen: false,
    }),
    "hackers.pub",
  );
  assert.equal(
    getArticleViewReferrerHostname({
      documentReferrer: "",
      currentUrl: "https://hackers.pub/@alice/2026/article",
      initialDocumentUrl: "https://hackers.pub/@alice/2026/article",
      clientNavigationSeen: true,
    }),
    "hackers.pub",
  );
});

test("article page comparisons ignore fragments but include searches", () => {
  assert.equal(
    articlePageLocationChanged(
      "https://hackers.pub/article#one",
      "https://hackers.pub/article#two",
    ),
    false,
  );
  assert.equal(
    articlePageLocationChanged(
      "https://hackers.pub/article",
      "https://hackers.pub/article?lang=ko",
    ),
    true,
  );
});

test("article referrers reject non-HTTP and malformed URLs", () => {
  assert.equal(
    getArticleViewReferrerHostname({
      documentReferrer: "data:text/plain,referrer",
      currentUrl: "https://hackers.pub/article",
      initialDocumentUrl: "https://hackers.pub/article",
      clientNavigationSeen: false,
    }),
    null,
  );
  assert.equal(
    getArticleViewReferrerHostname({
      documentReferrer: "https://external.example/path",
      currentUrl: "not a URL",
      initialDocumentUrl: null,
      clientNavigationSeen: false,
    }),
    null,
  );
});
