import assert from "node:assert/strict";
import test from "node:test";
import {
  getInitialVirtualListItemCount,
  measureVirtualListItem,
  measureVirtualListItemAfterMount,
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

test("measureVirtualListItem() exposes the index before measuring a connected row", () => {
  const element = {
    dataset: {},
    isConnected: true,
  } as unknown as HTMLDivElement;
  let measuredIndex: string | undefined;

  measureVirtualListItem(element, 7, (measuredElement) => {
    measuredIndex = measuredElement.dataset.index;
  });

  assert.equal(element.dataset.index, "7");
  assert.equal(measuredIndex, "7");
});

test("measureVirtualListItem() does not observe a detached row", () => {
  const element = {
    dataset: {},
    isConnected: false,
  } as unknown as HTMLDivElement;
  let measurements = 0;

  measureVirtualListItem(element, 7, () => measurements++);

  assert.equal(element.dataset.index, "7");
  assert.equal(measurements, 0);
});

test("measureVirtualListItemAfterMount() replaces the estimate before paint", async () => {
  const element = {
    dataset: { index: "7" },
    isConnected: true,
    offsetHeight: 512,
  } as unknown as HTMLDivElement;
  let observedIndex: string | undefined;
  let measurement: { index: number; size: number } | undefined;

  measureVirtualListItemAfterMount(
    element,
    () => "post-7",
    (measuredElement) => {
      observedIndex = measuredElement.dataset.index;
    },
    (index, size) => (measurement = { index, size }),
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.equal(observedIndex, "7");
  assert.deepEqual(measurement, { index: 7, size: 512 });
});

test("measureVirtualListItemAfterMount() measures the current row", async () => {
  const movedElement = {
    dataset: { index: "8" },
    isConnected: true,
    offsetHeight: 512,
  } as unknown as HTMLDivElement;
  const replacedElement = {
    dataset: { index: "7" },
    isConnected: true,
    offsetHeight: 512,
  } as unknown as HTMLDivElement;
  const measurements: Array<{ index: number; size: number }> = [];
  measureVirtualListItemAfterMount(
    movedElement,
    (index) => (index === 8 ? "post-8" : undefined),
    () => undefined,
    (index, size) => measurements.push({ index, size }),
  );
  measureVirtualListItemAfterMount(
    replacedElement,
    () => "post-8",
    () => undefined,
    (index, size) => measurements.push({ index, size }),
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  assert.deepEqual(measurements, [
    { index: 8, size: 512 },
    { index: 7, size: 512 },
  ]);
});

test("measureVirtualListItemAfterMount() retries until DOM insertion", async () => {
  let frameCallback: (() => void) | undefined;
  const element = {
    dataset: { index: "7" },
    isConnected: false,
    offsetHeight: 512,
    ownerDocument: {
      defaultView: {
        requestAnimationFrame: (callback: () => void) => {
          frameCallback = callback;
        },
      },
    },
  } as unknown as HTMLDivElement;
  let measurement: { index: number; size: number } | undefined;

  measureVirtualListItemAfterMount(
    element,
    () => "post-7",
    () => undefined,
    (index, size) => (measurement = { index, size }),
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(measurement, undefined);

  const firstFrameCallback = frameCallback;
  firstFrameCallback?.();
  assert.equal(measurement, undefined);
  assert.notEqual(frameCallback, firstFrameCallback);

  Object.assign(element, { isConnected: true });
  frameCallback?.();

  assert.deepEqual(measurement, { index: 7, size: 512 });
});

test("measureVirtualListItemAfterMount() cancels pending retries", async () => {
  let frameCallback: (() => void) | undefined;
  let cancelledFrame: number | undefined;
  const element = {
    dataset: { index: "7" },
    isConnected: false,
    offsetHeight: 512,
    ownerDocument: {
      defaultView: {
        requestAnimationFrame: (callback: () => void) => {
          frameCallback = callback;
          return 42;
        },
        cancelAnimationFrame: (frame: number) => {
          cancelledFrame = frame;
        },
      },
    },
  } as unknown as HTMLDivElement;
  let measurements = 0;

  const cancel = measureVirtualListItemAfterMount(
    element,
    () => "post-7",
    () => measurements++,
    () => measurements++,
  );
  await new Promise<void>((resolve) => queueMicrotask(resolve));

  cancel();
  Object.assign(element, { isConnected: true });
  frameCallback?.();

  assert.equal(cancelledFrame, 42);
  assert.equal(measurements, 0);
});
