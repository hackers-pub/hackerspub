export function shouldResetVirtualListMeasurements(
  previous: readonly string[],
  current: readonly string[],
): boolean {
  if (previous.length === 0) return false;
  const previousKeys = new Set(previous);
  return !current.some((key) => previousKeys.has(key));
}

export function getInitialVirtualListItemCount(
  totalCount: number,
  requestedCount: number,
): number {
  if (!Number.isFinite(requestedCount)) return totalCount;
  return Math.min(totalCount, Math.max(0, Math.trunc(requestedCount)));
}

export function virtualListFooterVisible(
  hasFooter: boolean,
  active: boolean,
  initialItemCount: number,
  totalCount: number,
): boolean {
  return hasFooter && (active || initialItemCount >= totalCount);
}

export function virtualListRowHasBottomBorder(
  index: number,
  totalCount: number,
  initialItemCount: number,
  active: boolean,
  hasFooter: boolean,
): boolean {
  const footerVisible = virtualListFooterVisible(
    hasFooter,
    active,
    initialItemCount,
    totalCount,
  );
  const borderEndIndex = active ? totalCount - 1 : initialItemCount - 1;
  return index < borderEndIndex || footerVisible;
}

export function measureVirtualListItem<T extends HTMLElement>(
  element: T,
  index: number,
  measureElement: (element: T) => void,
): void {
  element.dataset.index = index.toString();
  measureElement(element);
}
