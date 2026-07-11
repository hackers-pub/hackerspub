import assert from "node:assert";
import test from "node:test";
import {
  buildMemoryAlertDiagnostics,
  detectMemoryAlert,
} from "./clientMemoryWatchdog.ts";

type MemorySample = Parameters<typeof detectMemoryAlert>[0]["sample"];

function makeSample(overrides: Partial<MemorySample> = {}): MemorySample {
  return {
    sampledAt: 1_780_000_000_000,
    uptimeMs: 300_000,
    memoryApi: "memory",
    usedBytes: 100_000_000,
    totalBytes: 150_000_000,
    heapLimitBytes: 4_294_967_296,
    domNodes: 1_000,
    timeElements: 10,
    elementCounts: {
      total: 1_000,
      anchors: 100,
      buttons: 20,
      canvases: 0,
      forms: 1,
      iframes: 0,
      images: 30,
      inputs: 2,
      scripts: 10,
      stylesheets: 5,
      svgs: 40,
      textareas: 1,
      time: 10,
      videos: 0,
    },
    resourceTiming: {
      count: 20,
      recentCount: 2,
      transferBytes: 1_000_000,
      decodedBodyBytes: 2_000_000,
      initiators: {
        fetch: {
          count: 10,
          transferBytes: 100_000,
          decodedBodyBytes: 200_000,
        },
      },
      recentInitiators: {
        fetch: {
          count: 2,
          transferBytes: 20_000,
          decodedBodyBytes: 40_000,
        },
      },
    },
    storageEstimate: {
      usageBytes: 5_000_000,
      quotaBytes: 100_000_000,
    },
    viewport: {
      width: 1280,
      height: 720,
      devicePixelRatio: 2,
    },
    historyLength: 3,
    hasFocus: true,
    route: "/feed",
    visibilityState: "visible",
    ...overrides,
  };
}

test("detectMemoryAlert includes the sample trail for heap growth reports", () => {
  const baseline = makeSample({
    uptimeMs: 300_000,
    usedBytes: 700_000_000,
    route: "/fediverse",
  });
  const previous = makeSample({
    uptimeMs: 540_000,
    usedBytes: 900_000_000,
    route: "/notifications",
  });
  const intermediate = makeSample({
    uptimeMs: 480_000,
    usedBytes: 800_000_000,
    route: "/search",
  });
  const sample = makeSample({
    uptimeMs: 600_000,
    usedBytes: 1_050_000_000,
    route: "/feed",
  });
  const samples = [baseline, intermediate, previous, sample];

  const alert = detectMemoryAlert({
    baseline,
    previous,
    sample,
    samples,
    sampleCount: samples.length,
  });

  assert.ok(alert != null);
  assert.deepEqual(alert.reason, "heap_growth");
  assert.deepEqual(alert.samples, samples);
});

test("buildMemoryAlertDiagnostics reports deltas and route trail", () => {
  const baseline = makeSample({
    uptimeMs: 300_000,
    usedBytes: 700_000_000,
    domNodes: 1_000,
    route: "/fediverse",
  });
  const previous = makeSample({
    uptimeMs: 540_000,
    usedBytes: 900_000_000,
    domNodes: 1_100,
    route: "/notifications",
  });
  const intermediate = makeSample({
    uptimeMs: 480_000,
    usedBytes: 800_000_000,
    domNodes: 1_050,
    route: "/search",
  });
  const sample = makeSample({
    uptimeMs: 600_000,
    usedBytes: 1_050_000_000,
    domNodes: 1_250,
    route: "/feed",
    resourceTiming: {
      ...previous.resourceTiming,
      count: 35,
      recentCount: 8,
    },
    storageEstimate: {
      usageBytes: 6_500_000,
      quotaBytes: 100_000_000,
    },
  });
  const samples = [baseline, intermediate, previous, sample];
  const alert = detectMemoryAlert({
    baseline,
    previous,
    sample,
    samples,
    sampleCount: samples.length,
  });

  assert.ok(alert != null);
  const diagnostics = buildMemoryAlertDiagnostics(alert);

  assert.deepEqual(diagnostics.deltas.fromBaseline.usedBytes, 350_000_000);
  assert.deepEqual(diagnostics.deltas.fromPrevious.usedBytes, 150_000_000);
  assert.deepEqual(diagnostics.deltas.fromPrevious.domNodes, 150);
  assert.deepEqual(diagnostics.deltas.fromPrevious.resourceCount, 15);
  assert.deepEqual(
    diagnostics.deltas.fromBaseline.storageUsageBytes,
    1_500_000,
  );
  assert.deepEqual(diagnostics.deltas.bytesPerMinuteFromBaseline, 70_000_000);
  assert.deepEqual(diagnostics.distinctRoutesInTrail, [
    "/fediverse",
    "/search",
    "/notifications",
    "/feed",
  ]);
  assert.deepEqual(diagnostics.sampleTrail.map((entry) => entry.route), [
    "/fediverse",
    "/search",
    "/notifications",
    "/feed",
  ]);
});

test("detectMemoryAlert ignores DOM growth with a stable measured heap", () => {
  const baseline = makeSample({
    uptimeMs: 30_000,
    usedBytes: 10_600_000,
    domNodes: 5_534,
  });
  const previous = makeSample({
    uptimeMs: 270_000,
    usedBytes: 10_600_000,
    domNodes: 21_564,
  });
  const sample = makeSample({
    uptimeMs: 330_000,
    usedBytes: 10_600_000,
    domNodes: 22_898,
  });

  assert.equal(
    detectMemoryAlert({
      baseline,
      previous,
      sample,
      sampleCount: 6,
    }),
    null,
  );
});

test("detectMemoryAlert reports DOM growth with recent heap growth", () => {
  const baseline = makeSample({
    uptimeMs: 30_000,
    usedBytes: 10_600_000,
    domNodes: 5_000,
  });
  const previous = makeSample({
    uptimeMs: 270_000,
    usedBytes: 20_000_000,
    domNodes: 21_000,
  });
  const sample = makeSample({
    uptimeMs: 330_000,
    usedBytes: 21_000_000,
    domNodes: 22_500,
  });

  assert.equal(
    detectMemoryAlert({
      baseline,
      previous,
      sample,
      sampleCount: 6,
    })?.reason,
    "dom_growth",
  );
});

test("detectMemoryAlert reports DOM growth after cumulative heap growth", () => {
  const baseline = makeSample({
    uptimeMs: 30_000,
    usedBytes: 10_000_000,
    domNodes: 5_000,
  });
  const previous = makeSample({
    uptimeMs: 270_000,
    usedBytes: 21_000_000,
    domNodes: 21_000,
  });
  const sample = makeSample({
    uptimeMs: 330_000,
    usedBytes: 20_000_000,
    domNodes: 22_500,
  });

  assert.equal(
    detectMemoryAlert({
      baseline,
      previous,
      sample,
      sampleCount: 6,
    })?.reason,
    "dom_growth",
  );
});
