import assert from "node:assert/strict";
import test from "node:test";
import {
  getInitialVirtualListItemCount,
  measureVirtualListItem,
  shouldResetVirtualListMeasurements,
  virtualListFooterVisible,
  virtualListRowHasBottomBorder,
} from "./virtualList.ts";

test("measurement resets only for disjoint replacement keys", () => {
  assert.equal(shouldResetVirtualListMeasurements([], []), false);
  assert.equal(
    shouldResetVirtualListMeasurements(["a", "b"], ["a", "b"]),
    false,
  );
  assert.equal(
    shouldResetVirtualListMeasurements(["a", "b"], ["a", "b", "c"]),
    false,
  );
  assert.equal(
    shouldResetVirtualListMeasurements(["a", "b"], ["c", "a", "b"]),
    false,
  );
  assert.equal(
    shouldResetVirtualListMeasurements(["a", "b"], ["b", "a"]),
    false,
  );
  assert.equal(shouldResetVirtualListMeasurements(["a", "b"], ["b"]), false);
  assert.equal(
    shouldResetVirtualListMeasurements(["a", "b"], ["c", "d"]),
    true,
  );
  assert.equal(shouldResetVirtualListMeasurements(["a", "b"], []), true);
});

test("getInitialVirtualListItemCount() clamps the server-rendered range", () => {
  assert.equal(getInitialVirtualListItemCount(20, 5), 5);
  assert.equal(getInitialVirtualListItemCount(3, 5), 3);
  assert.equal(getInitialVirtualListItemCount(20, -1), 0);
  assert.equal(getInitialVirtualListItemCount(20, 3.9), 3);
  assert.equal(
    getInitialVirtualListItemCount(20, Number.POSITIVE_INFINITY),
    20,
  );
  assert.equal(getInitialVirtualListItemCount(20, Number.NaN), 20);
});

test("virtual list footer and borders match the rendered range", () => {
  assert.equal(virtualListFooterVisible(false, false, 3, 20), false);
  assert.equal(virtualListFooterVisible(true, false, 3, 20), false);
  assert.equal(virtualListFooterVisible(true, false, 20, 20), true);
  assert.equal(virtualListFooterVisible(true, true, 3, 20), true);
  assert.equal(virtualListFooterVisible(true, false, 0, 0), true);

  assert.equal(virtualListRowHasBottomBorder(0, 20, 3, false, false), true);
  assert.equal(virtualListRowHasBottomBorder(2, 20, 3, false, false), false);
  assert.equal(virtualListRowHasBottomBorder(2, 20, 3, false, true), false);
  assert.equal(virtualListRowHasBottomBorder(19, 20, 3, true, false), false);
  assert.equal(virtualListRowHasBottomBorder(19, 20, 3, true, true), true);
});

test("measureVirtualListItem() exposes the index before measuring", () => {
  const element = { dataset: {} } as unknown as HTMLDivElement;
  let measuredIndex: string | undefined;

  measureVirtualListItem(element, 7, (measuredElement) => {
    measuredIndex = measuredElement.dataset.index;
  });

  assert.equal(element.dataset.index, "7");
  assert.equal(measuredIndex, "7");
});
