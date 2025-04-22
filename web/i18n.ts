import { getFixedT, init } from "i18next";
import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };
import zhCN from "./locales/zh-CN.json" with { type: "json" };
import zhTW from "./locales/zh-TW.json" with { type: "json" };

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
  "zh-TW": {
    translation: zhTW,
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

export default (language?: string | null) => getFixedT(language ?? "en");
