/**
 * Finds the nearest language from a list of available languages.
 *
 * @example
 * ```ts
 * const availableLanguages = ["en-US", "ko", "zh-HK"];
 * findNearestLanguage("en", availableLanguages); // "en-US"
 * findNearestLanguage("ko-KR", availableLanguages); // "ko"
 * findNearestLanguage("zh", availableLanguages); // "zh-HK"
 * findNearestLanguage("zh-CN", availableLanguages); // "zh-HK"
 * findNearestLanguage("fr", availableLanguages); // undefined
 * ```
 * @param language The language to find the nearest match for.
 * @param availableLanguages The list of available languages to search in.
 * @returns The nearest language if found, otherwise `undefined`.
 */
export function findNearestLanguage(
  language: string,
  availableLanguages: string[],
): string | undefined {
  const lowerCaseLanguage = language.toLowerCase();

  // Check for exact match first (case-insensitive)
  const exactMatch = availableLanguages.find(
    (lang) => lang.toLowerCase() === lowerCaseLanguage,
  );
  if (exactMatch) {
    return exactMatch;
  }

  const languageParts = lowerCaseLanguage.split("-");
  const languageWithoutRegion = languageParts[0];

  // Find all available languages that start with the base language (case-insensitive)
  const matchingBaseLanguages = availableLanguages.filter((lang) => {
    const lowerCaseLang = lang.toLowerCase();
    return lowerCaseLang.startsWith(`${languageWithoutRegion}-`) ||
      lowerCaseLang === languageWithoutRegion;
  });

  if (matchingBaseLanguages.length > 0) {
    // Prefer exact base language match if available (case-insensitive)
    const exactBaseMatch = availableLanguages.find(
      (lang) => lang.toLowerCase() === languageWithoutRegion,
    );
    if (exactBaseMatch) {
      return exactBaseMatch;
    }
    // Otherwise, return the first available language with any region
    return matchingBaseLanguages[0];
  }

  return undefined;
}
