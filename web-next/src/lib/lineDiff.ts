/**
 * A minimal line-level diff, used by the translation editor's source
 * comparison.
 *
 * The workspace has no diff dependency, and the comparison only needs to show
 * a translator which lines of the original moved: word-level precision would
 * not change what they have to re-translate. Lines are matched by an LCS over
 * their exact text, which keeps unchanged paragraphs aligned and marks the
 * rest as removed then added.
 */
export type LineDiffKind = "unchanged" | "removed" | "added";

export interface LineDiffEntry {
  kind: LineDiffKind;
  text: string;
}

/**
 * Bounds the LCS table so a pathological comparison cannot stall the browser.
 * Beyond it the diff degrades to "everything was replaced", which is still an
 * honest rendering of a wholesale rewrite.
 */
const MAX_LCS_CELLS = 4_000_000;

export function diffLines(
  before: string,
  after: string,
): readonly LineDiffEntry[] {
  const source = splitLines(before);
  const target = splitLines(after);
  if (source.length * target.length > MAX_LCS_CELLS) {
    return [
      ...source.map((text): LineDiffEntry => ({ kind: "removed", text })),
      ...target.map((text): LineDiffEntry => ({ kind: "added", text })),
    ];
  }
  // lengths[i][j] is the LCS length of source[i..] and target[j..].
  const lengths: number[][] = Array.from({ length: source.length + 1 }, () =>
    Array.from({ length: target.length + 1 }, () => 0),
  );
  for (let i = source.length - 1; i >= 0; i--) {
    for (let j = target.length - 1; j >= 0; j--) {
      lengths[i][j] =
        source[i] === target[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const entries: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < source.length && j < target.length) {
    if (source[i] === target[j]) {
      entries.push({ kind: "unchanged", text: source[i] });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      entries.push({ kind: "removed", text: source[i] });
      i++;
    } else {
      entries.push({ kind: "added", text: target[j] });
      j++;
    }
  }
  for (; i < source.length; i++) {
    entries.push({ kind: "removed", text: source[i] });
  }
  for (; j < target.length; j++) {
    entries.push({ kind: "added", text: target[j] });
  }
  return entries;
}

/** `true` when the two texts differ in any line. */
export function hasLineChanges(entries: readonly LineDiffEntry[]): boolean {
  return entries.some((entry) => entry.kind !== "unchanged");
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replaceAll("\r\n", "\n").split("\n");
}
