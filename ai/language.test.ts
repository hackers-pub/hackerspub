import { assertEquals } from "@std/assert";
import { findNearestLanguage } from "./language.ts";

Deno.test("findNearestLanguage()", async (t) => {
  await t.step("exact match", () => {
    const availableLanguages = ["en-US", "ko", "zh-HK"];
    const result = findNearestLanguage("en-US", availableLanguages);
    assertEquals(result, "en-US");
  });

  await t.step("match base language when full language provided", () => {
    const availableLanguages = ["en-US", "ko", "zh-HK"];
    const result = findNearestLanguage("ko-KR", availableLanguages);
    assertEquals(result, "ko");
  });

  await t.step("match with region when base language provided", () => {
    const availableLanguages = ["en-US", "ko", "zh-HK"];
    const result = findNearestLanguage("zh", availableLanguages);
    assertEquals(result, "zh-HK");
  });

  await t.step("match with different region", () => {
    const availableLanguages = ["en-US", "ko", "zh-HK"];
    const result = findNearestLanguage("zh-CN", availableLanguages);
    assertEquals(result, "zh-HK");
  });

  await t.step("no match returns undefined", () => {
    const availableLanguages = ["en-US", "ko", "zh-HK"];
    const result = findNearestLanguage("fr", availableLanguages);
    assertEquals(result, undefined);
  });

  await t.step("empty language list returns undefined", () => {
    const result = findNearestLanguage("en", []);
    assertEquals(result, undefined);
  });

  await t.step("case insensitivity", () => {
    const availableLanguages = ["en-US", "ko", "zh-HK"];
    const result = findNearestLanguage("EN-US", availableLanguages);
    assertEquals(result, "en-US");
    const result2 = findNearestLanguage("ZH-hk", availableLanguages);
    assertEquals(result2, "zh-HK");
    const result3 = findNearestLanguage("KO-KR", availableLanguages);
    assertEquals(result3, "ko");
  });
});
