import { assertEquals } from "@std/assert";
import { findNearestLocale, type Locale } from "./i18n.ts";

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
