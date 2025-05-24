import { getLogger } from "@logtape/logtape";
import { detectAll } from "tinyld";

const logger = getLogger(["hackerspub", "models", "langdet"]);

export interface DetectLanguageOptions {
  text: string;
  acceptLanguage: string | null;
}

export function detectLanguage(options: DetectLanguageOptions): string | null {
  const acceptLanguages = parseAcceptLanguage(options.acceptLanguage ?? "");
  const langDetect = detectAll(sanitizeText(options.text));
  for (let i = 0; i < langDetect.length; i++) {
    langDetect[i].accuracy = (langDetect[i].accuracy +
      (acceptLanguages[langDetect[i].lang] ?? acceptLanguages["*"] ?? 0)) / 2;
  }
  langDetect.sort((a, b) => b.accuracy - a.accuracy);
  logger.debug("Detected languages: {languages}", { languages: langDetect });
  if (langDetect.length < 1) return null;
  const detectedLang = langDetect[0].lang;
  const language = detectedLang ?? null;
  logger.debug("Detected language: {language}", { language });
  return language;
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
