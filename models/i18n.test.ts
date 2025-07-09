import { assertEquals } from "@std/assert";
import { findNearestLocale, type Locale, negotiateLocale } from "./i18n.ts";

Deno.test("findNearestLocale()", async (t) => {
  await t.step("exact match", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("en-US", availableLocales);
    assertEquals(result, "en-US");
  });

  await t.step("match base locale when full locale provided", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("ko-KR", availableLocales);
    assertEquals(result, "ko");
  });

  await t.step("match with region when base locale provided", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("zh", availableLocales);
    assertEquals(result, "zh-HK");
  });

  await t.step("match with different region", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("zh-CN", availableLocales);
    assertEquals(result, "zh-HK");
  });

  await t.step("no match returns undefined", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("fr", availableLocales);
    assertEquals(result, undefined);
  });

  await t.step("empty locale list returns undefined", () => {
    const result = findNearestLocale("en", []);
    assertEquals(result, undefined);
  });

  await t.step("case insensitivity", () => {
    const availableLocales: Locale[] = ["en-US", "ko", "zh-HK"];
    const result = findNearestLocale("EN-US", availableLocales);
    assertEquals(result, "en-US");
    const result2 = findNearestLocale("ZH-hk", availableLocales);
    assertEquals(result2, "zh-HK");
    const result3 = findNearestLocale("KO-KR", availableLocales);
    assertEquals(result3, "ko");
  });
});

Deno.test("negotiateLocale()", async (t) => {
  await t.step("single locale - exact match", () => {
    const availableLocales = ["en-US", "ko-KR", new Intl.Locale("zh-CN")];
    const result = negotiateLocale("ko-KR", availableLocales);
    assertEquals(result?.baseName, "ko-KR");
  });

  await t.step("single locale - language-only match", () => {
    const availableLocales = ["en-US", "ko-KR", "zh-CN"];
    const result = negotiateLocale(new Intl.Locale("en"), availableLocales);
    assertEquals(result?.baseName, "en-US");
  });

  await t.step("single locale - no match", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
      new Intl.Locale("zh-CN"),
    ];
    const result = negotiateLocale(new Intl.Locale("ja"), availableLocales);
    assertEquals(result, undefined);
  });

  await t.step("multiple locales - first priority exact match", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
      new Intl.Locale("zh-CN"),
    ];
    const result = negotiateLocale([
      new Intl.Locale("ko-KR"),
      new Intl.Locale("en-US"),
    ], availableLocales);
    assertEquals(result?.baseName, "ko-KR");
  });

  await t.step("multiple locales - second priority language match", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
      new Intl.Locale("zh-CN"),
    ];
    const result = negotiateLocale([
      new Intl.Locale("ja"),
      new Intl.Locale("ko"),
    ], availableLocales);
    assertEquals(result?.baseName, "ko-KR");
  });

  await t.step("multiple locales - no match", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
      new Intl.Locale("zh-CN"),
    ];
    const result = negotiateLocale([
      new Intl.Locale("ja"),
      new Intl.Locale("fr"),
    ], availableLocales);
    assertEquals(result, undefined);
  });

  await t.step("empty available locales", () => {
    const result = negotiateLocale(new Intl.Locale("en"), []);
    assertEquals(result, undefined);
  });

  await t.step("empty wanted locales array", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
    ];
    const result = negotiateLocale([], availableLocales);
    assertEquals(result, undefined);
  });

  await t.step(
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
      assertEquals(result?.baseName, "zh-CN");
    },
  );

  await t.step("language match when exact region not available", () => {
    const availableLocales = [
      new Intl.Locale("zh-TW"),
      new Intl.Locale("en-US"),
    ];
    const result = negotiateLocale(new Intl.Locale("zh-CN"), availableLocales);
    assertEquals(result?.baseName, "zh-TW");
  });

  await t.step("maximization works correctly", () => {
    const availableLocales = [
      new Intl.Locale("en-US"),
      new Intl.Locale("ko-KR"),
    ];
    // "en" should match "en-US" via maximization
    const result = negotiateLocale(new Intl.Locale("en"), availableLocales);
    assertEquals(result?.baseName, "en-US");
  });

  await t.step(
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
      assertEquals(result?.baseName, "zh-TW");
    },
  );

  await t.step(
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
      assertEquals(result?.baseName, "zh-CN");
    },
  );

  await t.step(
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
      assertEquals(result?.baseName, "zh-CN");
    },
  );
});
