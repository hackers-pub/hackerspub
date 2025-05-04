// deno-fmt-ignore
export const POSSIBLE_LOCALES = [
  "aa", "ab", "ae", "af", "ak", "am", "an", "ar", "as", "av",
  "ay", "az", "ba", "be", "bg", "bh", "bi", "bm", "bn", "bo",
  "br", "bs", "ca", "ce", "ch", "co", "cr", "cs", "cu", "cv",
  "cy", "da", "de", "de-AT", "de-CH", "de-DE", "dv", "dz", "ee",
  "el", "en", "en-AU", "en-CA", "en-GB", "en-IN", "en-US", "eo",
  "es", "es-AR", "es-ES", "es-MX", "et", "eu", "fa", "ff", "fi",
  "fj", "fo", "fr", "fr-CA", "fr-FR", "fy", "ga", "gd", "gl",
  "gn", "gu", "gv", "ha", "he", "hi", "ho", "hr", "ht", "hu",
  "hy", "hz", "ia", "id", "ie", "ig", "ii", "ik", "io", "is",
  "it", "iu", "ja", "jv", "ka", "kg", "ki", "kj", "kk", "kl",
  "km", "kn", "ko", "ko-CN", "ko-KP", "ko-KR", "kr", "ks", "ku",
  "kv", "kw", "ky", "la", "lb", "lg", "li", "ln", "lo", "lt",
  "lu", "lv", "mg", "mh", "mi", "mk", "ml", "mn", "mr", "ms",
  "mt", "my", "na", "nb", "nd", "ne", "ng", "nl", "nn", "no",
  "nr", "nv", "ny", "oc", "oj", "om", "or", "os", "pa", "pi",
  "pl", "ps", "pt", "pt-BR", "pt-PT", "qu", "rm", "rn", "ro",
  "ru", "rw", "sa", "sc", "sd", "se", "sg", "si", "sk", "sl",
  "sm", "sn", "so", "sq", "sr", "ss", "st", "su", "sv", "sw",
  "ta", "te", "tg", "th", "ti", "tk", "tl", "tn", "to", "tr",
  "ts", "tt", "tw", "ty", "ug", "uk", "ur", "uz", "ve", "vi",
  "vo", "wa", "wo", "xh", "yi", "yo", "za", "zh", "zh-CN",
  "zh-HK", "zh-MO", "zh-TW", "zu",
] as const;

export type Locale = typeof POSSIBLE_LOCALES[number];

export function isLocale(value: string): value is Locale {
  return POSSIBLE_LOCALES.includes(value as Locale);
}

/**
 * Normalizes a locale code to a standard format.
 *
 * @example
 * ```ts
 * normalizeLocale("en"); // "en"
 * normalizeLocale("EN-us"); // "en-US"
 * normalizeLocale("ko_KR"); // "ko-KR"
 * normalizeLocale("zh-Hans"); // "zh-CN"
 * normalizeLocale("zh-Hant"); // "zh-TW"
 * normalizeLocale("og"); // undefined
 * ```
 *
 * @param value The locale code to normalize.
 * @returns The normalized locale code if valid, otherwise undefined.
 */
export function normalizeLocale(value: string): Locale | undefined {
  let normalized = value.toLowerCase().replaceAll("_", "-");
  if (normalized === "zh-hans") {
    normalized = "zh-cn";
  } else if (normalized === "zh-hant") {
    normalized = "zh-tw";
  } else if (normalized.includes("-")) {
    const [lang, region] = normalized.split("-");
    normalized = `${lang}-${region.toUpperCase()}`;
  }
  return isLocale(normalized) ? normalized : undefined;
}

/**
 * Finds the nearest locale from a list of available locales.
 *
 * @example
 * ```ts
 * const availableLocales = ["en-US", "ko", "zh-HK"];
 * findNearestLocale("en", availableLanguages); // "en-US"
 * findNearestLocale("ko-KR", availableLanguages); // "ko"
 * findNearestLocale("zh", availableLanguages); // "zh-HK"
 * findNearestLocale("zh-CN", availableLanguages); // "zh-HK"
 * findNearestLocale("fr", availableLanguages); // undefined
 * ```
 * @param locale The locale to find the nearest match for.
 * @param availableLocales The list of available locales to search in.
 * @returns The nearest locale if found, otherwise `undefined`.
 */
export function findNearestLocale(
  locale: string,
  availableLocales: Locale[],
): Locale | undefined {
  const lowerCaseLanguage = locale.toLowerCase();

  // Check for exact match first (case-insensitive)
  const exactMatch = availableLocales.find(
    (lang) => lang.toLowerCase() === lowerCaseLanguage,
  );
  if (exactMatch) {
    return exactMatch;
  }

  const languageParts = lowerCaseLanguage.split("-");
  const languageWithoutRegion = languageParts[0];

  // Find all available locales that start with the base locale (case-insensitive)
  const matchingBaseLanguages = availableLocales.filter((lang) => {
    const lowerCaseLang = lang.toLowerCase();
    return lowerCaseLang.startsWith(`${languageWithoutRegion}-`) ||
      lowerCaseLang === languageWithoutRegion;
  });

  if (matchingBaseLanguages.length > 0) {
    // Prefer exact base locale match if available (case-insensitive)
    const exactBaseMatch = availableLocales.find(
      (lang) => lang.toLowerCase() === languageWithoutRegion,
    );
    if (exactBaseMatch) {
      return exactBaseMatch;
    }
    // Otherwise, return the first available locale with any region
    return matchingBaseLanguages[0];
  }

  return undefined;
}
