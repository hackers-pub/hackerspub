import assert from "node:assert";
import { describe, it } from "node:test";
import {
  COC_LOCALES,
  getCocProvisions,
  getCocVersion,
  getCodeOfConduct,
  resolveCocLocale,
} from "./coc.ts";

describe("resolveCocLocale()", () => {
  it("returns an exact match", () => {
    assert.equal(resolveCocLocale("ja"), "ja");
    assert.equal(resolveCocLocale("zh-CN"), "zh-CN");
  });

  it("matches the base language", () => {
    assert.equal(resolveCocLocale("ko-KR"), "ko");
    assert.equal(resolveCocLocale("ja-JP"), "ja");
  });

  it("matches a different region of the same language", () => {
    assert.equal(resolveCocLocale("en-US"), "en");
  });

  it("matches Chinese variants by script", () => {
    assert.equal(resolveCocLocale("zh-HK"), "zh-TW");
    assert.equal(resolveCocLocale("zh-Hant"), "zh-TW");
    assert.equal(resolveCocLocale("zh-SG"), "zh-CN");
    assert.equal(resolveCocLocale("zh-Hans"), "zh-CN");
  });

  it("falls back to English for unavailable languages", () => {
    assert.equal(resolveCocLocale("fr"), "en");
    assert.equal(resolveCocLocale(undefined), "en");
    assert.equal(resolveCocLocale("not a locale!"), "en");
  });
});

describe("getCodeOfConduct()", () => {
  it("returns the English document by default", async () => {
    const coc = await getCodeOfConduct();
    assert.match(coc, /Hackers' Pub Code of Conduct/);
  });

  it("returns the localized document", async () => {
    const coc = await getCodeOfConduct("ko");
    assert.match(coc, /행동 강령/);
  });
});

describe("getCocProvisions()", () => {
  it("parses the English provisions", async () => {
    const provisions = await getCocProvisions("en");
    assert.ok(provisions.length > 0);
    for (const provision of provisions) {
      assert.match(provision.id, /^\d+\.\d+$/);
      assert.ok(provision.section.trim().length > 0);
      assert.ok(provision.title.trim().length > 0);
      assert.ok(provision.text.trim().length > 0);
    }
    const ids = provisions.map((p) => p.id);
    assert.deepEqual(ids, [...new Set(ids)]);
  });

  it("starts numbering at 1.1", async () => {
    const provisions = await getCocProvisions("en");
    assert.equal(provisions[0].id, "1.1");
    assert.equal(provisions[0].section, "Our Commitment");
    assert.equal(provisions[0].title, "Our Values");
  });

  it("does not treat the document title as a section", async () => {
    const provisions = await getCocProvisions("en");
    assert.ok(
      provisions.every((p) => p.section !== "Hackers' Pub Code of Conduct"),
    );
  });

  it("keeps provision ids consistent across locales", async () => {
    const english = await getCocProvisions("en");
    const englishIds = english.map((p) => p.id);
    for (const locale of COC_LOCALES) {
      const localized = await getCocProvisions(locale);
      assert.deepEqual(
        localized.map((p) => p.id),
        englishIds,
        `provision ids diverge for locale ${locale}`,
      );
    }
  });

  it("resolves non-canonical locales", async () => {
    const provisions = await getCocProvisions("ko-KR");
    assert.equal(provisions[0].id, "1.1");
    assert.notEqual(provisions[0].title, "Our Values");
  });
});

describe("getCocVersion()", () => {
  it("returns a commit hash or null", async () => {
    const version = await getCocVersion();
    if (version != null) {
      assert.match(version, /^[0-9a-f]{40}$/);
    }
  });

  it("caches the result", async () => {
    const first = await getCocVersion();
    const second = await getCocVersion();
    assert.equal(first, second);
  });
});
