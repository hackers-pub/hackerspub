export interface ViewerComparableActor {
  readonly isViewer: boolean;
  readonly local: boolean;
  readonly username: string;
}

export function isViewerActor(
  actor: ViewerComparableActor | null | undefined,
  viewerUsername: string | undefined,
): boolean {
  return (
    actor != null &&
    (actor.isViewer || (actor.local && actor.username === viewerUsername))
  );
}
