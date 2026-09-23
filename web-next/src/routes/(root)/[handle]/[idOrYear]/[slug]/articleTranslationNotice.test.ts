import { assertStringIncludes } from "@std/assert";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Pins where the reader-facing translation UI sits and what gates it.
 *
 * These are placement and gating facts that no unit test of the presentation
 * helpers can see: the notice has to be encountered before the prose it
 * qualifies, and it has to be driven by the published review state rather than
 * by anything about the viewer, because it is server-rendered for signed-out
 * visitors.
 */
const pagePath = new URL("./index.tsx", import.meta.url);

test("the freshness notice sits between the language control and the body", async () => {
  const source = await readFile(pagePath, "utf8");
  const switcher = source.indexOf("<ArticleLanguageSwitcher");
  const notice = source.indexOf("<ArticleSourceChangedNotice");
  const toc = source.indexOf("<ArticleInlineToc");
  const body = source.indexOf("<HtmlContent");
  assert.ok(switcher > 0 && notice > 0 && toc > 0 && body > 0);
  // Language control near the author information, then the warning, then the
  // navigation aid, then the translated text.
  assert.ok(
    switcher < notice,
    "the language control must come before the freshness notice",
  );
  assert.ok(
    notice < toc,
    "the freshness notice must come before the table of contents",
  );
  assert.ok(
    notice < body,
    "the freshness notice must come before the translated body",
  );
});

test("the notice is driven by the published review state, not by the viewer", async () => {
  const source = await readFile(pagePath, "utf8");
  const start = source.indexOf("<ArticleSourceChangedNotice");
  const end = source.indexOf("/>", start);
  assert.ok(start > 0 && end > start);
  const element = source.slice(start, end);
  assertStringIncludes(element, "freshness={presentation().freshness}");
  // Nothing about signing in may gate it: a signed-out, server-rendered visit
  // has to show the same notice.
  assert.ok(!/viewer|isViewer|actingAccount/.test(element));
});

test("the credit line is rendered beside the author, not in place of it", async () => {
  const source = await readFile(pagePath, "utf8");
  const authorLine = source.indexOf("<PostAuthorLine");
  const credit = source.indexOf("<ArticleTranslationCredit");
  assert.ok(authorLine > 0 && credit > authorLine);
});
