import {
  findNearestLocale,
  isLocale,
  type Locale,
} from "@hackerspub/models/i18n";
import { join } from "@std/path/join";
import { generateText, type LanguageModelV1 } from "ai";

const PROMPT_LANGUAGES: Locale[] = (
  await Array.fromAsync(
    Deno.readDir(join(import.meta.dirname!, "prompts", "summary")),
  )
).map((f) => f.name.replace(/\.md$/, "")).filter(isLocale);

async function getSummaryPrompt(
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string> {
  const promptLanguage = findNearestLocale(targetLanguage, PROMPT_LANGUAGES) ??
    findNearestLocale(sourceLanguage, PROMPT_LANGUAGES) ?? "en";
  const promptPath = join(
    import.meta.dirname!,
    "prompts",
    "summary",
    `${promptLanguage}.md`,
  );
  const promptTemplate = await Deno.readTextFile(promptPath);
  const displayNames = new Intl.DisplayNames(promptLanguage, {
    type: "language",
  });
  return promptTemplate.replaceAll(
    "{{targetLanguage}}",
    displayNames.of(targetLanguage) ?? targetLanguage,
  );
}

export interface SummaryOptions {
  model: LanguageModelV1;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
}

export async function summarize(options: SummaryOptions): Promise<string> {
  const system = await getSummaryPrompt(
    options.sourceLanguage,
    options.targetLanguage,
  );
  const { text } = await generateText({
    model: options.model,
    system,
    prompt: options.text,
  });
  return text;
}
