import {
  findNearestLocale,
  isLocale,
  type Locale,
} from "@hackerspub/models/i18n";
import { getLogger } from "@logtape/logtape";
import { join } from "@std/path/join";
import { generateText, type LanguageModelV1 } from "ai";
import { splitTextIntoChunks } from "./chunk.ts";

const logger = getLogger(["hackerspub", "ai", "translate"]);

const MAX_CHUNK_SIZE = 3000;

const PROMPT_LANGUAGES: Locale[] = (
  await Array.fromAsync(
    Deno.readDir(join(import.meta.dirname!, "prompts", "translate")),
  )
).map((f) => f.name.replace(/\.md$/, "")).filter(isLocale);

/**
 * Gets the translation prompt for a given language pair
 * Optionally appends partial translation context if the text is a segment
 */
async function getTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
): Promise<string> {
  const promptLanguage = findNearestLocale(targetLanguage, PROMPT_LANGUAGES) ??
    findNearestLocale(sourceLanguage, PROMPT_LANGUAGES) ?? "en";

  // Read the main translation prompt
  const promptPath = join(
    import.meta.dirname!,
    "prompts",
    "translate",
    `${promptLanguage}.md`,
  );
  let promptTemplate = await Deno.readTextFile(promptPath);

  const displayNames = new Intl.DisplayNames(promptLanguage, {
    type: "language",
  });

  promptTemplate = promptTemplate.replaceAll(
    "{{targetLanguage}}",
    displayNames.of(targetLanguage) ?? targetLanguage,
  );

  return promptTemplate;
}

export interface TranslationOptions {
  model: LanguageModelV1;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
}

/**
 * Translates an individual chunk of text
 */
async function translateChunk(
  options: TranslationOptions,
  chunks: string[],
  translatedChunks: string[],
): Promise<string> {
  const system = await getTranslationPrompt(
    options.sourceLanguage,
    options.targetLanguage,
  );
  const lastChunk = chunks[chunks.length - 1];

  let { text } = await generateText({
    model: options.model,
    messages: [
      { role: "system", content: system },
      ...translatedChunks.flatMap((translated, index) => [
        { role: "user" as const, content: chunks[index] },
        { role: "assistant" as const, content: translated },
      ]),
      { role: "user" as const, content: lastChunk },
    ],
  });

  if (
    text.match(/^\s*```(?:\s*(?:markdown|md|commonmark))/) &&
    text.match(/```\s*$/) &&
    !(lastChunk.match(/^\s*```/) && lastChunk.match(/```\s*$/))
  ) {
    text = text.replaceAll(
      /^\s*```(?:\s*(?:markdown|md|commonmark))|```\s*$/g,
      "",
    ).trim();
  }

  return text;
}

export async function translate(options: TranslationOptions): Promise<string> {
  // Use the existing translation method for short texts
  if (options.text.length <= MAX_CHUNK_SIZE) {
    return translateChunk(options, [options.text], []);
  }

  // Split long texts into chunks and translate each one
  const chunks = splitTextIntoChunks(options.text, MAX_CHUNK_SIZE);
  const translatedChunks: string[] = [];

  for (let index = 1; index <= chunks.length; index++) {
    const translatedChunk = await translateChunk(
      options,
      chunks.slice(0, index),
      translatedChunks,
    );
    logger.debug(
      "Translated chunk {index}/{total}.",
      {
        index,
        total: chunks.length,
        chunks: chunks.slice(0, index),
      },
    );
    translatedChunks.push(translatedChunk);
  }

  // Combine the translated chunks
  return translatedChunks.join("\n\n");
}
