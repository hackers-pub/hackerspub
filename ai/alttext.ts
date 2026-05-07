import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isLocale,
  type Locale,
  negotiateLocale,
} from "@hackerspub/models/i18n";
import { generateText, type LanguageModel } from "ai";

const MAX_CONTEXT_LENGTH = 1000;
const MAX_ALT_TEXT_TOKENS = 200;

const PROMPT_LANGUAGES: Locale[] = (
  await readdir(
    join(import.meta.dirname!, "prompts", "alttext"),
    { withFileTypes: true },
  )
).map((f) => f.name.replace(/\.md$/, "")).filter(isLocale);

const promptCache = new Map<string, string>();

async function getAltTextPrompt(language: string): Promise<string> {
  const locale = new Intl.Locale(language);
  const promptLocale = negotiateLocale(locale, PROMPT_LANGUAGES) ??
    new Intl.Locale("en");
  const cacheKey = promptLocale.baseName;
  const cached = promptCache.get(cacheKey);
  if (cached != null) return cached;
  const promptPath = join(
    import.meta.dirname!,
    "prompts",
    "alttext",
    `${cacheKey}.md`,
  );
  const content = await readFile(promptPath, "utf8");
  promptCache.set(cacheKey, content);
  return content;
}

export interface AltTextOptions {
  model: LanguageModel;
  imageUrl: string;
  language: string;
  context?: string;
}

export async function generateAltText(
  options: AltTextOptions,
): Promise<string> {
  const { model, imageUrl, language } = options;
  const context = options.context?.slice(0, MAX_CONTEXT_LENGTH);
  const systemPrompt = await getAltTextPrompt(language);

  const textContent = context
    ? `Generate alt text for this image. Context from the accompanying note: ${context}`
    : "Generate alt text for this image.";

  const result = await generateText({
    model,
    system: systemPrompt,
    maxOutputTokens: MAX_ALT_TEXT_TOKENS,
    messages: [{
      role: "user",
      content: [
        { type: "image", image: new URL(imageUrl) },
        { type: "text", text: textContent },
      ],
    }],
  });

  return result.text.trim();
}
