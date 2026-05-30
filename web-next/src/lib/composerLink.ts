/**
 * Append `url` on its own paragraph at the end of `content`, unless the content
 * already contains that URL.
 *
 * Used by the inline News discussion composer so an opinion gets associated with
 * the link being discussed, without duplicating a URL the author already wrote
 * or pasted.
 *
 * Caveat: the server derives a post's `linkId` from the *first* external link in
 * the rendered content, so appending at the bottom only joins this link's
 * discussion when it ends up first, i.e. the author wrote no other link. A
 * plain-text opinion (the common case) works; an opinion that leads with a
 * different link attaches to that link instead. The presence check is a plain
 * substring match, matching the requested behavior ("don't duplicate a URL the
 * author already included").
 */
export function ensureLinkInContent(content: string, url: string): string {
  const trimmed = content.trim();
  if (trimmed.length < 1) return url;
  return trimmed.includes(url) ? trimmed : `${trimmed}\n\n${url}`;
}
