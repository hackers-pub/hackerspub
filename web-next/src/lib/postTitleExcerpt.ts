export function buildPostTitleExcerpt(
  excerpt: string | null | undefined,
  truncate: boolean,
  graphemeLimit = 80,
): string {
  if (!truncate) return excerpt ?? "";
  const normalized = (excerpt ?? "").replace(/\s+/g, " ").trim();
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      normalized,
    ),
    ({ segment }) => segment,
  );
  if (graphemes.length <= graphemeLimit) return normalized;
  return `${graphemes
    .slice(0, graphemeLimit - 1)
    .join("")
    .trimEnd()}…`;
}
