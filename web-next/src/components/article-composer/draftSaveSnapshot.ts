export interface DraftFormSnapshot {
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
}

export function createDraftFormSnapshot(
  title: string,
  content: string,
  tags: readonly string[],
): DraftFormSnapshot {
  return {
    title: title.trim(),
    content: content.trim(),
    tags: [...tags],
  };
}

export function draftFormMatchesSnapshot(
  current: DraftFormSnapshot,
  snapshot: DraftFormSnapshot,
): boolean {
  return current.title === snapshot.title &&
    current.content === snapshot.content &&
    current.tags.length === snapshot.tags.length &&
    current.tags.every((tag, index) => tag === snapshot.tags[index]);
}
