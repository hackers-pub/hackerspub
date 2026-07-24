import { generateText, type LanguageModel } from "ai";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findNearestLocale,
  isLocale,
  type Locale,
} from "@hackerspub/models/i18n";
import type { SummaryOptions as ApplicationSummaryOptions } from "@hackerspub/models/services";
import { removeDetailsFromSummaryInput } from "@hackerspub/models/summary";

const PROMPT_LANGUAGES: Locale[] = (
  await readdir(join(import.meta.dirname!, "prompts", "summary"), {
    withFileTypes: true,
  })
)
  .map((f) => f.name.replace(/\.md$/, ""))
  .filter(isLocale);

export interface SummaryOptions extends Omit<
  ApplicationSummaryOptions,
  "model"
> {
  model: LanguageModel;
}

async function getSummaryPrompt(
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string> {
  const promptLanguage =
    findNearestLocale(targetLanguage, PROMPT_LANGUAGES) ??
    findNearestLocale(sourceLanguage, PROMPT_LANGUAGES) ??
    "en";
  const promptPath = join(
    import.meta.dirname!,
    "prompts",
    "summary",
    `${promptLanguage}.md`,
  );
  const promptTemplate = await readFile(promptPath, "utf8");
  const displayNames = new Intl.DisplayNames(promptLanguage, {
    type: "language",
  });
  return promptTemplate.replaceAll(
    "{{targetLanguage}}",
    displayNames.of(targetLanguage) ?? targetLanguage,
  );
}

export { removeDetailsFromSummaryInput };

export async function summarize(options: SummaryOptions): Promise<string> {
  const system = await getSummaryPrompt(
    options.sourceLanguage,
    options.targetLanguage,
  );
  const { text } = await generateText({
    model: options.model,
    system,
    prompt: removeDetailsFromSummaryInput(options.text),
  });
  return text;
}
