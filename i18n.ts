import { getFixedT, init } from "i18next";
import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };

declare module "i18next" {
  interface CustomTypeOptions {
    resources: {
      translation: typeof en;
    };
  }
}

const resources = {
  en: {
    translation: en,
  },
  ja: {
    translation: ja,
  },
  ko: {
    translation: ko,
  },
  "zh-CN": {
    translation: zhCN,
  },
} as const;

export type Language = keyof typeof resources;

export const SUPPORTED_LANGUAGES = Object.keys(resources) as Language[];

export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: string): value is Language {
  return SUPPORTED_LANGUAGES.includes(value as Language);
}

export function normalizeLanguage(value?: string | null): Language | undefined {
  if (value == null) return undefined;
  value = value.trim();
  if (isLanguage(value)) return value;
  else if (value.includes("-") || value.includes("_")) {
    const language = value.replace(/[_-].*$/, "");
    const region = value.replace(/^[^-_]*[_-]/, "");
    const languageWithRegion = `${language}-${region.toUpperCase()}`;
    if (isLanguage(languageWithRegion)) return languageWithRegion;
    else if (isLanguage(language)) return language;
  } else {
    for (const lang of SUPPORTED_LANGUAGES) {
      if (lang.startsWith(`${value}-`)) return lang;
    }
  }
}

await init({
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: {
    escapeValue: false,
  },
  resources,
});

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

export default (language?: string | null) => getFixedT(language ?? "en");
