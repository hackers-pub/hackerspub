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
    title,
    content,
    tags: [...tags],
  };
}

export function createDraftSaveInput(
  snapshot: DraftFormSnapshot,
): DraftFormSnapshot {
  return {
    title: snapshot.title.trim(),
    content: snapshot.content.trim(),
    tags: [...snapshot.tags],
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

export interface DraftSaveReconciliation {
  readonly formReconciled: boolean;
  readonly baseline: DraftFormSnapshot;
}

export function reconcileDraftSaveResponse(
  current: DraftFormSnapshot,
  submitted: DraftFormSnapshot,
  saved: DraftFormSnapshot,
): DraftSaveReconciliation {
  const formMatchesSubmitted = draftFormMatchesSnapshot(
    current,
    submitted,
  );
  const formMatchesSaved = draftFormMatchesSnapshot(current, saved);
  return {
    formReconciled: formMatchesSubmitted || formMatchesSaved,
    baseline: formMatchesSubmitted ? submitted : saved,
  };
}
