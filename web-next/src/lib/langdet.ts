// Client-side language detection without @logtape/logtape dependency
// This is a browser-compatible version of @hackerspub/models/langdet

import { detectAll } from "tinyld.browser";

export interface DetectLanguageOptions {
  text: string;
  acceptLanguage: string | null;
}

export function detectLanguage(options: DetectLanguageOptions): string | null {
  const acceptLanguages = parseAcceptLanguage(options.acceptLanguage ?? "");
  const langDetect = detectAll(sanitizeText(options.text)) as {
    lang: string;
    accuracy: number;
  }[];
  for (let i = 0; i < langDetect.length; i++) {
    langDetect[i].accuracy = (langDetect[i].accuracy +
      (acceptLanguages[langDetect[i].lang] ?? acceptLanguages["*"] ?? 0)) / 2;
  }
  langDetect.sort((a, b) => b.accuracy - a.accuracy);
  if (langDetect.length < 1) return null;
  const detectedLang = langDetect[0].lang;
  return detectedLang ?? null;
}

function parseAcceptLanguage(acceptLanguage: string): Record<string, number> {
  const langs: [string, number][] = acceptLanguage.split(",").map((lang) => {
    const [code, q] = lang.trim().split(";").map((s) => s.trim());
    return [code.substring(0, 2), q == null ? 1 : parseFloat(q.split("=")[1])];
  });
  langs.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(langs);
}

function sanitizeText(text: string): string {
  const URL_PATTERN = /https?:\/\/[^\s]+/g;
  const MENTION_PATTERN =
    /@[\p{L}\p{N}._-]+(@(?:[\p{L}\p{N}][\p{L}\p{N}_-]*\.)+[\p{L}\p{N}]{2,})?/giu;

  return text.replaceAll(URL_PATTERN, "")
    .replaceAll(MENTION_PATTERN, "");
}
