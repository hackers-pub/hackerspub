import { getLogger } from "@logtape/logtape";
import { join } from "@std/path/join";
import { generateText, type LanguageModelV1 } from "ai";
import { splitTextIntoChunks } from "./chunk.ts";
import { findNearestLanguage } from "./language.ts";

const logger = getLogger(["hackerspub", "ai", "translate"]);

const MAX_CHUNK_SIZE = 3000;

const PROMPT_LANGUAGES: string[] = (
  await Array.fromAsync(
    Deno.readDir(join(import.meta.dirname!, "prompts", "translate")),
  )
).map((f) => f.name.replace(/\.md$/, ""));

/**
 * Gets the translation prompt for a given language pair
 * Optionally appends partial translation context if the text is a segment
 */
async function getTranslationPrompt(
  sourceLanguage: string,
  targetLanguage: string,
  isPartialText = false,
): Promise<string> {
  const promptLanguage =
    findNearestLanguage(targetLanguage, PROMPT_LANGUAGES) ??
      findNearestLanguage(sourceLanguage, PROMPT_LANGUAGES) ?? "en";

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

  // Append partial translation context if needed
  if (isPartialText) {
    try {
      const partialPromptPath = join(
        import.meta.dirname!,
        "prompts",
        "translate-partial",
        `${promptLanguage}.md`,
      );
      const partialPrompt = await Deno.readTextFile(partialPromptPath);
      promptTemplate += "\n\n" + partialPrompt;
    } catch (_) {
      // Fallback to English if language-specific partial prompt is not available
      if (promptLanguage !== "en") {
        try {
          const englishPartialPromptPath = join(
            import.meta.dirname!,
            "prompts",
            "translate-partial",
            "en.md",
          );
          const englishPartialPrompt = await Deno.readTextFile(
            englishPartialPromptPath,
          );
          promptTemplate += "\n\n" + englishPartialPrompt;
        } catch (_) {
          // Silently fail if even the English partial prompt is not available
        }
      }
    }
  }

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
  chunk: string,
  isPartialText: boolean,
): Promise<string> {
  const system = await getTranslationPrompt(
    options.sourceLanguage,
    options.targetLanguage,
    isPartialText,
  );

  let { text } = await generateText({
    model: options.model,
    system,
    prompt: chunk,
  });

  if (
    text.match(/^\s*```(?:\s*(?:markdown|md|commonmark))/) &&
    text.match(/```\s*$/) &&
    !(chunk.match(/^\s*```/) && chunk.match(/```\s*$/))
  ) {
    text = text.replaceAll(
      /^\s*```(?:\s*(?:markdown|md|commonmark))|```\s*$/g,
      "",
    ).trim();
  }

  // Find and fix mismatched fence characters
  const codeBlockRegex =
    /((`{3,}|~{3,}))([\s\S]*?)(?:\s*)((?:\2)|(?:[`~]{3,}))/g;
  text = text.replace(
    codeBlockRegex,
    (match, opening, _openingChar, content, closing) => {
      // If opening and closing don't match in character type, fix the closing to match the opening
      if (opening.charAt(0) !== closing.charAt(0)) {
        const correctedClosing = opening.charAt(0).repeat(opening.length);
        return `${opening}${content}${correctedClosing}`;
      }
      return match;
    },
  );

  return text;
}

export async function translate(options: TranslationOptions): Promise<string> {
  // Use the existing translation method for short texts
  if (options.text.length <= MAX_CHUNK_SIZE) {
    return translateChunk(options, options.text, false);
  }

  // Split long texts into chunks and translate each one
  const chunks = splitTextIntoChunks(options.text, MAX_CHUNK_SIZE);
  const translatedChunks: string[] = [];

  let index = 1;
  for (const chunk of chunks) {
    const translatedChunk = await translateChunk(
      options,
      chunk,
      chunks.length > 1, // isPartialText = true if we have multiple chunks
    );
    logger.debug(
      "Translated chunk {index}/{total}.",
      {
        index,
        total: chunks.length,
        chunk,
      },
    );
    index++;
    translatedChunks.push(translatedChunk);
  }

  // Combine the translated chunks
  return translatedChunks.join("\n\n");
}
