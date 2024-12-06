import { getFixedT, init } from "i18next";
import en from "./locales/en.json" with { type: "json" };
import ja from "./locales/ja.json" with { type: "json" };
import ko from "./locales/ko.json" with { type: "json" };

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
} as const;

export type Language = keyof typeof resources;

export const LANGUAGES = Object.keys(resources) as Language[];

export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: string): value is Language {
  return LANGUAGES.includes(value as Language);
}

await init({
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: {
    escapeValue: false,
  },
  resources,
});

export default (language?: string | null) => getFixedT(language ?? "en");
