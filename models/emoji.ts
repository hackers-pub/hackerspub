export const REACTION_EMOJIS = [
  "❤️",
  "🎉",
  "😂",
  "😲",
  "🤔",
  "😢",
  "👀",
] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return REACTION_EMOJIS.includes(value as ReactionEmoji);
}

export interface ReactionGroup {
  emoji?: string | null;
  customEmoji?: {
    name: string;
  } | null;
}

export function sortReactionGroups<T extends ReactionGroup>(
  groups: readonly T[],
): T[] {
  if (!groups) return [];

  // Sort by REACTION_EMOJIS order first, then other emojis, then custom emojis
  return [...groups].sort((a, b) => {
    const emojiA = a.emoji;
    const emojiB = b.emoji;

    // Standard emojis come before custom emojis
    if (emojiA && !emojiB) return -1;
    if (!emojiA && emojiB) return 1;

    // If both are standard emojis
    if (emojiA && emojiB) {
      const isAReactionEmoji = isReactionEmoji(emojiA);
      const isBReactionEmoji = isReactionEmoji(emojiB);

      // REACTION_EMOJIS come first
      if (isAReactionEmoji && !isBReactionEmoji) return -1;
      if (!isAReactionEmoji && isBReactionEmoji) return 1;

      // If both are in REACTION_EMOJIS, sort by their order
      if (isAReactionEmoji && isBReactionEmoji) {
        const indexA = REACTION_EMOJIS.indexOf(emojiA as ReactionEmoji);
        const indexB = REACTION_EMOJIS.indexOf(emojiB as ReactionEmoji);
        return indexA - indexB;
      }

      // If neither is in REACTION_EMOJIS, sort alphabetically
      return emojiA.localeCompare(emojiB);
    }

    // Both are custom emojis, sort by name
    const nameA = a.customEmoji?.name || "";
    const nameB = b.customEmoji?.name || "";
    return nameA.localeCompare(nameB);
  });
}

export const DEFAULT_REACTION_EMOJI = REACTION_EMOJIS[0];

const CUSTOM_EMOJI_REGEXP = /:([a-z0-9_-]+):/gi;
const HTML_ELEMENT_REGEXP = /<\/?[^>]+>/g;

export function renderCustomEmojis(
  html: string,
  emojis: Record<string, string>,
): string;
export function renderCustomEmojis(
  html: null,
  emojis: Record<string, string>,
): null;
export function renderCustomEmojis(
  html: undefined,
  emojis: Record<string, string>,
): undefined;
export function renderCustomEmojis(
  html: string | null,
  emojis: Record<string, string>,
): string | null;
export function renderCustomEmojis(
  html: string | undefined,
  emojis: Record<string, string>,
): string | undefined;
export function renderCustomEmojis(
  html: string | null | undefined,
  emojis: Record<string, string>,
): string | null | undefined;

export function renderCustomEmojis(
  html: string | null | undefined,
  emojis: Record<string, string>,
): string | null | undefined {
  if (html == null) return html;
  let result = "";
  let index = 0;
  for (const match of html.matchAll(HTML_ELEMENT_REGEXP)) {
    result += replaceEmojis(html.substring(index, match.index));
    result += match[0];
    index = match.index + match[0].length;
  }
  result += replaceEmojis(html.substring(index));
  return result;

  function replaceEmojis(html: string): string {
    return html.replaceAll(CUSTOM_EMOJI_REGEXP, (match) => {
      const emoji = emojis[match] ?? emojis[match.replace(/^:|:$/g, "")];
      if (emoji == null) return match;
      return `<img src="${emoji}" alt="${match}" style="
        margin: 0;
        height: 1em;
        vertical-align: middle;
        display: inline-block;
      " />`;
    });
  }
}
