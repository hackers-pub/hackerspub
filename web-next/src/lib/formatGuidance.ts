export const LONG_NOTE_GRAPHEME_THRESHOLD = 800;
export const LONG_NOTE_PARAGRAPH_THRESHOLD = 4;
export const SHORT_ARTICLE_GRAPHEME_THRESHOLD = 280;
export const SHORT_ARTICLE_MAX_PARAGRAPHS = 1;

export function shouldSuggestArticleForNote(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === "") return false;
  return (
    countGraphemes(trimmed) >= LONG_NOTE_GRAPHEME_THRESHOLD ||
    countParagraphs(trimmed) >= LONG_NOTE_PARAGRAPH_THRESHOLD
  );
}

export function shouldSuggestNoteForArticle(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === "") return false;
  return (
    countGraphemes(trimmed) < SHORT_ARTICLE_GRAPHEME_THRESHOLD &&
    countParagraphs(trimmed) <= SHORT_ARTICLE_MAX_PARAGRAPHS
  );
}

export function buildNoteDraftContentFromArticle(
  title: string,
  content: string,
): string {
  const trimmedTitle = title.trim();
  const trimmedContent = content.trim();
  if (trimmedTitle === "") return trimmedContent;
  if (trimmedContent === "") return trimmedTitle;
  return `${trimmedTitle}\n\n${trimmedContent}`;
}

export function countParagraphs(content: string): number {
  return content
    .trim()
    .split(/\n\s*\n+/)
    .filter((paragraph) => paragraph.trim() !== "").length;
}

function countGraphemes(content: string): number {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: "grapheme",
    });
    return Array.from(segmenter.segment(content)).length;
  }
  return Array.from(content).length;
}
