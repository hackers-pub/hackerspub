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
