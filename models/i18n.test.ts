import assert from "node:assert";
import { describe, it } from "node:test";
import { findNearestLocale, type Locale, negotiateLocale } from "./i18n.ts";

describe("findNearestLocale()", () => {
  it("exact match", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("en-US", availableLocales);
    assert.deepEqual(result, "en-US");
  });

  it("match base locale when full locale provided", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("ko-KR", availableLocales);
    assert.deepEqual(result, "ko");
  });

  it("match with region when base locale provided", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("zh", availableLocales);
    assert.deepEqual(result, "zh-HK");
  });

  it("match with different region", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("zh-CN", availableLocales);
    assert.deepEqual(result, "zh-HK");
  });

  it("no match returns undefined", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("fr", availableLocales);
    assert.deepEqual(result, undefined);
  });

  it("empty locale list returns undefined", () => {
    const result = findNearestLocale("en", []);
    assert.deepEqual(result, undefined);
  });

  it("case insensitivity", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("EN-US", availableLocales);
    assert.deepEqual(result, "en-US");
    const result2 = findNearestLocale("ZH-hk", availableLocales);
    assert.deepEqual(result2, "zh-HK");
    const result3 = findNearestLocale("KO-KR", availableLocales);
    assert.deepEqual(result3, "ko");
  });
});

describe("negotiateLocale()", () => {
  it("single locale - exact match", () => {
    const availableLocales = ["en-US", "ko-KR", new Intl.Locale("zh-CN")];
    const result = negotiateLocale("ko-KR", availableLocales);
    assert.deepEqual(result?.baseName, "ko-KR");
  });

  it("single locale - language-only match", () => {
    const availableLocales = ["en-US", "ko-KR", "zh-CN"];
    const result = negotiateLocale(new Intl.Locale("en"), availableLocales);
    assert.deepEqual(result?.baseName, "en-US");
  });

  it("single locale - no match", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
      new Intl.Locale("zh-CN"),
    ];
    const result = negotiateLocale(new Intl.Locale("ja"), availableLocales);
    assert.deepEqual(result, undefined);
  });

  it("multiple locales - first priority exact match", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
      new Intl.Locale("zh-CN"),
    ];
    const result = negotiateLocale([
      new Intl.Locale("ko-KR"),
      new Intl.Locale("en-US"),
    ], availableLocales);
    assert.deepEqual(result?.baseName, "ko-KR");
  });

  it("multiple locales - second priority language match", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
      new Intl.Locale("zh-CN"),
    ];
    const result = negotiateLocale([
      new Intl.Locale("ja"),
      new Intl.Locale("ko"),
    ], availableLocales);
    assert.deepEqual(result?.baseName, "ko-KR");
  });

  it("multiple locales - no match", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
      new Intl.Locale("zh-CN"),
    ];
    const result = negotiateLocale([
      new Intl.Locale("ja"),
      new Intl.Locale("fr"),
    ], availableLocales);
    assert.deepEqual(result, undefined);
  });

  it("empty available locales", () => {
    const result = negotiateLocale(new Intl.Locale("en"), []);
    assert.deepEqual(result, undefined);
  });

  it("empty wanted locales array", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
    ];
    const result = negotiateLocale([], availableLocales);
    assert.deepEqual(result, undefined);
  });

  it(
    "language match prefers exact region over different region",
    () => {
      const availableLocales = [
        new Intl.Locale("zh-TW"),
        new Intl.Locale("zh-CN"),
      ];
      const result = negotiateLocale(
        new Intl.Locale("zh-CN"),
        availableLocales,
      );
      assert.deepEqual(result?.baseName, "zh-CN");
    },
  );

  it("language match when exact region not available", () => {
    const availableLocales = [
      new Intl.Locale("zh-TW"),
      new Intl.Locale("en-US"),
    ];
    const result = negotiateLocale(new Intl.Locale("zh-CN"), availableLocales);
    assert.deepEqual(result?.baseName, "zh-TW");
  });

  it("maximization works correctly", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
    ];
    // "en" should match "en-US" via maximization
    const result = negotiateLocale(new Intl.Locale("en"), availableLocales);
    assert.deepEqual(result?.baseName, "en-US");
  });

  it(
    "Chinese script-based matching - zh-HK vs zh-CN and zh-TW",
    () => {
      const availableLocales = [
        new Intl.Locale("zh-CN"),
        new Intl.Locale("zh-TW"),
      ];
      const result = negotiateLocale(
        new Intl.Locale("zh-HK"),
        availableLocales,
      );

      // zh-HK should match zh-TW (both Traditional Chinese / Hant script)
      assert.deepEqual(result?.baseName, "zh-TW");
    },
  );

  it(
    "Chinese script-based matching - zh-CN should prefer zh-CN over zh-TW",
    () => {
      const availableLocales = [
        new Intl.Locale("zh-TW"),
        new Intl.Locale("zh-CN"),
      ];
      const result = negotiateLocale(
        new Intl.Locale("zh-CN"),
        availableLocales,
      );
      // zh-CN should match zh-CN exactly (both Simplified Chinese / Hans script)
      assert.deepEqual(result?.baseName, "zh-CN");
    },
  );

  it(
    "Chinese script-based matching - zh-SG should prefer zh-CN over zh-TW",
    () => {
      const availableLocales = [
        new Intl.Locale("zh-TW"),
        new Intl.Locale("zh-CN"),
      ];
      const result = negotiateLocale(
        new Intl.Locale("zh-SG"),
        availableLocales,
      );
      // zh-SG uses Simplified Chinese (Hans), should match zh-CN
      assert.deepEqual(result?.baseName, "zh-CN");
    },
  );
});
