import { fetchLinkedPages } from "@vertana/context-web";
import type { RequiredContextSource } from "@vertana/core";
import { translate as vertanaTranslate } from "@vertana/facade";
import type { LanguageModel } from "ai";

export interface TranslationOptions {
  model: LanguageModel;
  sourceLanguage: string;
  targetLanguage: string;
  text: string;
  /** Author's display name */
  authorName?: string;
  /** Author's bio/description */
  authorBio?: string;
  /** Article tags for context */
  tags?: string[];
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
  const contextSources: RequiredContextSource[] = [];

  const authorSource = createAuthorContextSource(
    options.authorName,
    options.authorBio,
  );
  if (authorSource) contextSources.push(authorSource);

  const tagsSource = createTagsContextSource(options.tags);
  if (tagsSource) contextSources.push(tagsSource);

  // Add web context to fetch linked pages
  const webContext = fetchLinkedPages({
    text: options.text,
    mediaType: "text/markdown",
  });
  contextSources.push(webContext);

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
