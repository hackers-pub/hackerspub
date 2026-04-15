import assert from "node:assert/strict";
import test from "node:test";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  createFedCtx,
  createTestKv,
  makeGuestContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const codeOfConductQuery = parse(`
  query CodeOfConduct($locale: Locale!) {
    codeOfConduct(locale: $locale) {
      locale
      title
      markdown
      html
    }
  }
`);

const markdownGuideQuery = parse(`
  query MarkdownGuide($locale: Locale!) {
    markdownGuide(locale: $locale) {
      locale
      title
      markdown
      html
    }
  }
`);

const searchGuideQuery = parse(`
  query SearchGuide($locale: Locale!) {
    searchGuide(locale: $locale) {
      locale
      title
      markdown
      html
    }
  }
`);

const privacyPolicyQuery = parse(`
  query PrivacyPolicy($locale: Locale!) {
    privacyPolicy(locale: $locale) {
      locale
      title
      markdown
      html
    }
  }
`);

function makeDocContext(
  tx: Parameters<typeof withRollback>[0] extends (tx: infer T) => Promise<void>
    ? T
    : never,
) {
  const { kv } = createTestKv();
  const fedCtx = createFedCtx(tx, { kv });
  fedCtx.getDocumentLoader = () => Promise.resolve({}) as never;
  fedCtx.lookupObject = () => Promise.resolve(null);

  return makeGuestContext(tx, {
    fedCtx,
    kv,
  });
}

test("codeOfConduct falls back from regioned locales to the base locale", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: codeOfConductQuery,
      variableValues: { locale: "en-US" },
      contextValue: makeDocContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const document = (toPlainJson(result.data) as {
      codeOfConduct: {
        locale: string;
        title: string;
        markdown: string;
        html: string;
      };
    }).codeOfConduct;

    assert.equal(document.locale, "en");
    assert.ok(document.title.length > 0);
    assert.match(document.markdown, /^#/m);
    assert.match(document.html, /<h1/i);
  });
});

test("markdownGuide returns the requested locale document", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: markdownGuideQuery,
      variableValues: { locale: "ko" },
      contextValue: makeDocContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const document = (toPlainJson(result.data) as {
      markdownGuide: {
        locale: string;
        title: string;
        markdown: string;
        html: string;
      };
    }).markdownGuide;

    assert.equal(document.locale, "ko");
    assert.ok(document.markdown.length > 0);
    assert.ok(document.html.length > 0);
  });
});

test("searchGuide returns the requested locale document", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: searchGuideQuery,
      variableValues: { locale: "ja" },
      contextValue: makeDocContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const document = (toPlainJson(result.data) as {
      searchGuide: {
        locale: string;
        title: string;
        markdown: string;
        html: string;
      };
    }).searchGuide;

    assert.equal(document.locale, "ja");
    assert.match(document.markdown, /lang:/);
    assert.match(document.html, /<table/i);
  });
});

test("privacyPolicy falls back from regioned locales to the base locale", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: privacyPolicyQuery,
      variableValues: { locale: "zh-HK" },
      contextValue: makeDocContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const document = (toPlainJson(result.data) as {
      privacyPolicy: {
        locale: string;
        title: string;
        markdown: string;
        html: string;
      };
    }).privacyPolicy;

    assert.equal(document.locale, "zh-TW");
    assert.ok(document.title.length > 0);
    assert.match(document.markdown, /^#/m);
    assert.match(document.html, /<h1/i);
  });
});
