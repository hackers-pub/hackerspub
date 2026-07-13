import { fetchWebPage } from "@vertana/context-web";
import type { ContextSource, RequiredContextSource } from "@vertana/core";
import { translate as vertanaTranslate } from "@vertana/facade";
import type { LanguageModel } from "ai";
import type { TranslationOptions as ApplicationTranslationOptions } from "@hackerspub/models/services";

export interface TranslationOptions
  extends Omit<ApplicationTranslationOptions, "model" | "summarizationModel"> {
  model: LanguageModel;
  summarizationModel?: LanguageModel;
}

/**
 * Creates a required context source with author information
 */
function createAuthorContextSource(
  authorName?: string,
  authorBio?: string,
): RequiredContextSource | null {
  if (!authorName && !authorBio) return null;

  return {
    name: "author-info",
    description: "Information about the article author",
    mode: "required",
    gather: async () => {
      const parts: string[] = [];
      if (authorName) {
        parts.push(`Author: ${authorName}`);
      }
      if (authorBio) {
        parts.push(`Bio: ${authorBio}`);
      }
      return {
        content: parts.join("\n"),
      };
    },
  };
}

/**
 * Creates a required context source with article tags
 */
function createTagsContextSource(
  tags?: string[],
): RequiredContextSource | null {
  if (!tags || tags.length === 0) return null;

  return {
    name: "article-tags",
    description: "Tags/categories of the article for context",
    mode: "required",
    gather: async () => ({
      content: `Article topics: ${tags.join(", ")}`,
    }),
  };
}

export async function translate(options: TranslationOptions): Promise<string> {
  // Build context sources
  const contextSources: ContextSource[] = [];

  const authorSource = createAuthorContextSource(
    options.authorName,
    options.authorBio,
  );
  if (authorSource) contextSources.push(authorSource);

  const tagsSource = createTagsContextSource(options.tags);
  if (tagsSource) contextSources.push(tagsSource);

  // Expose linked-page fetching as a passive tool the model can call
  // when it actually needs context, instead of dumping every linked
  // page's full body into the system prompt up front (which made the
  // translator confuse the context for the text to translate).
  contextSources.push(fetchWebPage({
    maxCharsPerPage: 10_000,
    maxTotalChars: 30_000,
    ...(options.summarizationModel && {
      summarize: {
        model: options.summarizationModel,
        maxChars: 3_000,
      },
    }),
  }));

  const result = await vertanaTranslate(
    options.model,
    options.targetLanguage,
    options.text,
    {
      sourceLanguage: options.sourceLanguage,
      mediaType: "text/markdown",
      tone: "technical",
      refinement: true,
      dynamicGlossary: true,
      contextSources,
    },
  );

  return result.text;
}
