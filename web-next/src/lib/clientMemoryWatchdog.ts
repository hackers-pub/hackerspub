import * as Sentry from "@sentry/solidstart";

interface MemoryInfo {
  readonly usedJSHeapSize?: number;
  readonly totalJSHeapSize?: number;
  readonly jsHeapSizeLimit?: number;
}

interface UserAgentSpecificMemory {
  readonly bytes: number;
}

interface MemoryPerformance extends Performance {
  readonly memory?: MemoryInfo;
  measureUserAgentSpecificMemory?: () => Promise<UserAgentSpecificMemory>;
}

interface NetworkConnection {
  readonly effectiveType?: string;
  readonly downlink?: number;
  readonly rtt?: number;
  readonly saveData?: boolean;
}

interface NavigatorWithConnection extends Navigator {
  readonly connection?: NetworkConnection;
}

interface ViewportSnapshot {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

interface ElementCounts {
  readonly total: number;
  readonly anchors: number;
  readonly buttons: number;
  readonly canvases: number;
  readonly forms: number;
  readonly iframes: number;
  readonly images: number;
  readonly inputs: number;
  readonly scripts: number;
  readonly stylesheets: number;
  readonly svgs: number;
  readonly textareas: number;
  readonly time: number;
  readonly videos: number;
}

interface ResourceInitiatorSummary {
  readonly count: number;
  readonly transferBytes: number;
  readonly decodedBodyBytes: number;
}

interface ResourceTimingSummary {
  count: number;
  recentCount: number;
  transferBytes: number;
  decodedBodyBytes: number;
  initiators: Record<string, ResourceInitiatorSummary>;
  recentInitiators: Record<string, ResourceInitiatorSummary>;
}

interface StorageEstimateSnapshot {
  readonly usageBytes?: number;
  readonly quotaBytes?: number;
}

interface NetworkSnapshot {
  readonly effectiveType?: string;
  readonly downlink?: number;
  readonly rtt?: number;
  readonly saveData?: boolean;
}

interface MemorySample {
  readonly sampledAt: number;
  readonly uptimeMs: number;
  readonly memoryApi: "measureUserAgentSpecificMemory" | "memory" | "none";
  readonly usedBytes?: number;
  readonly totalBytes?: number;
  readonly heapLimitBytes?: number;
  readonly domNodes: number;
  readonly timeElements: number;
  readonly elementCounts: ElementCounts;
  readonly resourceTiming: ResourceTimingSummary;
  readonly storageEstimate?: StorageEstimateSnapshot;
  readonly viewport: ViewportSnapshot;
  readonly network?: NetworkSnapshot;
  readonly historyLength: number;
  readonly hasFocus: boolean;
  readonly wasDiscarded?: boolean;
  readonly route: string;
  readonly visibilityState: DocumentVisibilityState;
}

interface MemoryDelta {
  readonly usedBytes?: number;
  readonly totalBytes?: number;
  readonly domNodes: number;
  readonly timeElements: number;
  readonly resourceCount: number;
  readonly recentResourceCount: number;
  readonly storageUsageBytes?: number;
}

interface MemorySampleTrailEntry {
  readonly sampledAt: number;
  readonly uptimeMs: number;
  readonly route: string;
  readonly usedBytes?: number;
  readonly totalBytes?: number;
  readonly domNodes: number;
  readonly timeElements: number;
  readonly resourceCount: number;
  readonly recentResourceCount: number;
  readonly storageUsageBytes?: number;
  readonly visibilityState: DocumentVisibilityState;
}

interface MemoryAlertDiagnostics {
  readonly thresholds: {
    readonly absoluteUsedBytes: number;
    readonly usedBytesGrowth: number;
    readonly domNodes: number;
    readonly domNodesGrowth: number;
  };
  readonly deltas: {
    readonly fromBaseline: MemoryDelta;
    readonly fromPrevious: MemoryDelta;
    readonly bytesPerMinuteFromBaseline?: number;
    readonly bytesPerMinuteFromPrevious?: number;
  };
  readonly sampleTrail: readonly MemorySampleTrailEntry[];
  readonly distinctRoutesInTrail: readonly string[];
}

interface MemoryAlert {
  readonly reason: string;
  readonly level: "warning";
  readonly sample: MemorySample;
  readonly baseline: MemorySample;
  readonly previous: MemorySample;
  readonly samples: readonly MemorySample[];
  readonly sampleCount: number;
}

const SAMPLE_INTERVAL_MS = 60_000;
const INITIAL_SAMPLE_DELAY_MS = 30_000;
const MIN_SAMPLE_COUNT = 4;
const MIN_UPTIME_MS = 5 * 60_000;

const ABSOLUTE_USED_BYTES_THRESHOLD = 1_000_000_000;
const USED_BYTES_GROWTH_THRESHOLD = 256_000_000;
const DOM_NODES_THRESHOLD = 20_000;
const DOM_NODES_GROWTH_THRESHOLD = 10_000;
const RECENT_RESOURCE_WINDOW_MS = 5 * 60_000;

const REPORT_SESSION_KEY = "hp:client-memory-watchdog-reported";
const MAX_REPORTS_PER_SESSION = 2;

let started = false;
const reportedReasons = new Set<string>();

export function startClientMemoryWatchdog(): void {
  if (started) return;
  started = true;

  const samples: MemorySample[] = [];
  let interval: number | undefined;

  const sample = async () => {
    if (document.visibilityState !== "visible") return;

    const current = await collectMemorySample();
    const nextSamples = [...samples, current];
    const baseline = nextSamples[0] ?? current;
    const previous = samples.at(-1) ?? current;
    samples.push(current);
    if (samples.length > 12) samples.shift();
    const alertSamples = buildAlertSampleTrail(nextSamples);

    const alert = detectMemoryAlert({
      sample: current,
      baseline,
      previous,
      samples: alertSamples,
      sampleCount: alertSamples.length,
    });
    if (alert != null) reportMemoryAlert(alert);
  };

  const initialTimer = window.setTimeout(() => {
    void sample().catch(() => {});
    interval = window.setInterval(
      () => void sample().catch(() => {}),
      SAMPLE_INTERVAL_MS,
    );
  }, INITIAL_SAMPLE_DELAY_MS);

  window.addEventListener(
    "pagehide",
    () => {
      clearTimeout(initialTimer);
      if (interval != null) clearInterval(interval);
    },
    { once: true },
  );
}

function buildAlertSampleTrail(
  samples: readonly MemorySample[],
): readonly MemorySample[] {
  if (samples.length <= 12) return samples;
  const baseline = samples[0];
  return [baseline, ...samples.slice(-11)];
}

async function collectMemorySample(): Promise<MemorySample> {
  const performance = window.performance as MemoryPerformance;
  const [measured, storageEstimate] = await Promise.all([
    measureMemory(performance),
    estimateStorage(),
  ]);
  const elementCounts = collectElementCounts();

  return {
    sampledAt: Date.now(),
    uptimeMs: Math.round(performance.now()),
    route: window.location.pathname,
    visibilityState: document.visibilityState,
    domNodes: elementCounts.total,
    timeElements: elementCounts.time,
    elementCounts,
    resourceTiming: collectResourceTiming(performance),
    storageEstimate,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    network: collectNetworkSnapshot(),
    historyLength: window.history.length,
    hasFocus: document.hasFocus(),
    wasDiscarded: "wasDiscarded" in document
      ? Boolean(document.wasDiscarded)
      : undefined,
    ...measured,
  };
}

async function measureMemory(
  performance: MemoryPerformance,
): Promise<
  Pick<
    MemorySample,
    "heapLimitBytes" | "memoryApi" | "totalBytes" | "usedBytes"
  >
> {
  if (performance.measureUserAgentSpecificMemory != null) {
    try {
      const result = await performance.measureUserAgentSpecificMemory();
      return {
        memoryApi: "measureUserAgentSpecificMemory",
        usedBytes: result.bytes,
      };
    } catch {
      // Fall back to the less precise Chromium API below when permission or
      // browser support prevents the user-agent-specific measurement.
    }
  }

  if (performance.memory != null) {
    return {
      memoryApi: "memory",
      usedBytes: performance.memory.usedJSHeapSize,
      totalBytes: performance.memory.totalJSHeapSize,
      heapLimitBytes: performance.memory.jsHeapSizeLimit,
    };
  }

  return { memoryApi: "none" };
}

export function detectMemoryAlert(input: {
  readonly sample: MemorySample;
  readonly baseline: MemorySample;
  readonly previous: MemorySample;
  readonly samples?: readonly MemorySample[];
  readonly sampleCount: number;
}): MemoryAlert | null {
  const { baseline, previous, sample, sampleCount } = input;
  if (sampleCount < MIN_SAMPLE_COUNT || sample.uptimeMs < MIN_UPTIME_MS) {
    return null;
  }

  const usedGrowth = sample.usedBytes != null && baseline.usedBytes != null
    ? sample.usedBytes - baseline.usedBytes
    : 0;
  const usedRecentGrowth =
    sample.usedBytes != null && previous.usedBytes != null
      ? sample.usedBytes - previous.usedBytes
      : 0;
  if (
    sample.usedBytes != null &&
    sample.usedBytes >= ABSOLUTE_USED_BYTES_THRESHOLD &&
    usedGrowth >= USED_BYTES_GROWTH_THRESHOLD &&
    usedRecentGrowth > 0
  ) {
    return {
      reason: "heap_growth",
      level: "warning",
      sample,
      baseline,
      previous,
      samples: input.samples ?? [baseline, previous, sample],
      sampleCount,
    };
  }

  const domGrowth = sample.domNodes - baseline.domNodes;
  const domRecentGrowth = sample.domNodes - previous.domNodes;
  if (
    sample.domNodes >= DOM_NODES_THRESHOLD &&
    domGrowth >= DOM_NODES_GROWTH_THRESHOLD &&
    domRecentGrowth > 0
  ) {
    return {
      reason: "dom_growth",
      level: "warning",
      sample,
      baseline,
      previous,
      samples: input.samples ?? [baseline, previous, sample],
      sampleCount,
    };
  }

  return null;
}

function reportMemoryAlert(alert: MemoryAlert): void {
  if (!shouldReportMemoryAlert(alert.reason)) return;
  const diagnostics = buildMemoryAlertDiagnostics(alert);

  Sentry.captureMessage("Possible client memory leak", {
    level: alert.level,
    fingerprint: ["web-next-client-memory-watchdog", alert.reason],
    tags: {
      area: "web-next",
      memory_api: alert.sample.memoryApi,
      memory_watchdog_reason: alert.reason,
      route: alert.sample.route,
    },
    contexts: {
      memory_watchdog: {
        reason: alert.reason,
        sample: alert.sample,
        baseline: alert.baseline,
        previous: alert.previous,
        sampleCount: alert.sampleCount,
        diagnostics,
      },
    },
  });
}

export function buildMemoryAlertDiagnostics(
  alert: MemoryAlert,
): MemoryAlertDiagnostics {
  const fromBaseline = calculateDelta(alert.sample, alert.baseline);
  const fromPrevious = calculateDelta(alert.sample, alert.previous);
  const baselineDurationMs = alert.sample.uptimeMs - alert.baseline.uptimeMs;
  const previousDurationMs = alert.sample.uptimeMs - alert.previous.uptimeMs;

  return {
    thresholds: {
      absoluteUsedBytes: ABSOLUTE_USED_BYTES_THRESHOLD,
      usedBytesGrowth: USED_BYTES_GROWTH_THRESHOLD,
      domNodes: DOM_NODES_THRESHOLD,
      domNodesGrowth: DOM_NODES_GROWTH_THRESHOLD,
    },
    deltas: {
      fromBaseline,
      fromPrevious,
      bytesPerMinuteFromBaseline: calculateBytesPerMinute(
        fromBaseline.usedBytes,
        baselineDurationMs,
      ),
      bytesPerMinuteFromPrevious: calculateBytesPerMinute(
        fromPrevious.usedBytes,
        previousDurationMs,
      ),
    },
    sampleTrail: alert.samples.map(toSampleTrailEntry),
    distinctRoutesInTrail: [
      ...new Set(alert.samples.map((sample) => sample.route)),
    ],
  };
}

function collectElementCounts(): ElementCounts {
  return {
    total: document.getElementsByTagName("*").length,
    anchors: document.getElementsByTagName("a").length,
    buttons: document.getElementsByTagName("button").length,
    canvases: document.getElementsByTagName("canvas").length,
    forms: document.getElementsByTagName("form").length,
    iframes: document.getElementsByTagName("iframe").length,
    images: document.getElementsByTagName("img").length,
    inputs: document.getElementsByTagName("input").length,
    scripts: document.scripts.length,
    stylesheets: document.styleSheets.length,
    svgs: document.getElementsByTagName("svg").length,
    textareas: document.getElementsByTagName("textarea").length,
    time: document.getElementsByTagName("time").length,
    videos: document.getElementsByTagName("video").length,
  };
}

function collectResourceTiming(
  performance: Performance,
): ResourceTimingSummary {
  const entries = performance.getEntriesByType("resource")
    .filter((entry): entry is PerformanceResourceTiming =>
      "initiatorType" in entry
    );
  const recentCutoff = performance.now() - RECENT_RESOURCE_WINDOW_MS;
  const summary = createResourceTimingSummary();

  for (const entry of entries) {
    addResourceTimingEntry(summary, entry, false);
    if (entry.startTime >= recentCutoff) {
      addResourceTimingEntry(summary, entry, true);
    }
  }

  return summary;
}

function createResourceTimingSummary(): ResourceTimingSummary {
  return {
    count: 0,
    recentCount: 0,
    transferBytes: 0,
    decodedBodyBytes: 0,
    initiators: {},
    recentInitiators: {},
  };
}

function addResourceTimingEntry(
  summary: ResourceTimingSummary,
  entry: PerformanceResourceTiming,
  recent: boolean,
): void {
  const initiatorType = entry.initiatorType || "unknown";
  const target = recent ? summary.recentInitiators : summary.initiators;
  const current = target[initiatorType] ?? {
    count: 0,
    transferBytes: 0,
    decodedBodyBytes: 0,
  };
  target[initiatorType] = {
    count: current.count + 1,
    transferBytes: current.transferBytes + entry.transferSize,
    decodedBodyBytes: current.decodedBodyBytes + entry.decodedBodySize,
  };

  if (recent) {
    summary.recentCount += 1;
  } else {
    summary.count += 1;
    summary.transferBytes += entry.transferSize;
    summary.decodedBodyBytes += entry.decodedBodySize;
  }
}

async function estimateStorage(): Promise<StorageEstimateSnapshot | undefined> {
  try {
    const estimate = await navigator.storage?.estimate();
    if (estimate == null) return undefined;
    return {
      usageBytes: estimate.usage,
      quotaBytes: estimate.quota,
    };
  } catch {
    return undefined;
  }
}

function collectNetworkSnapshot(): NetworkSnapshot | undefined {
  const connection = (navigator as NavigatorWithConnection).connection;
  if (connection == null) return undefined;
  return {
    effectiveType: connection.effectiveType,
    downlink: connection.downlink,
    rtt: connection.rtt,
    saveData: connection.saveData,
  };
}

function calculateDelta(
  sample: MemorySample,
  reference: MemorySample,
): MemoryDelta {
  return {
    usedBytes: sample.usedBytes != null && reference.usedBytes != null
      ? sample.usedBytes - reference.usedBytes
      : undefined,
    totalBytes: sample.totalBytes != null && reference.totalBytes != null
      ? sample.totalBytes - reference.totalBytes
      : undefined,
    domNodes: sample.domNodes - reference.domNodes,
    timeElements: sample.timeElements - reference.timeElements,
    resourceCount: sample.resourceTiming.count - reference.resourceTiming.count,
    recentResourceCount: sample.resourceTiming.recentCount -
      reference.resourceTiming.recentCount,
    storageUsageBytes: sample.storageEstimate?.usageBytes != null &&
        reference.storageEstimate?.usageBytes != null
      ? sample.storageEstimate.usageBytes - reference.storageEstimate.usageBytes
      : undefined,
  };
}

function calculateBytesPerMinute(
  bytes: number | undefined,
  durationMs: number,
): number | undefined {
  if (bytes == null || durationMs <= 0) return undefined;
  return Math.round(bytes / (durationMs / 60_000));
}

function toSampleTrailEntry(sample: MemorySample): MemorySampleTrailEntry {
  return {
    sampledAt: sample.sampledAt,
    uptimeMs: sample.uptimeMs,
    route: sample.route,
    usedBytes: sample.usedBytes,
    totalBytes: sample.totalBytes,
    domNodes: sample.domNodes,
    timeElements: sample.timeElements,
    resourceCount: sample.resourceTiming.count,
    recentResourceCount: sample.resourceTiming.recentCount,
    storageUsageBytes: sample.storageEstimate?.usageBytes,
    visibilityState: sample.visibilityState,
  };
}

function shouldReportMemoryAlert(reason: string): boolean {
  if (reportedReasons.has(reason)) return false;
  if (reportedReasons.size >= MAX_REPORTS_PER_SESSION) return false;

  try {
    const raw = window.sessionStorage.getItem(REPORT_SESSION_KEY);
    const parsed = raw == null ? [] : JSON.parse(raw);
    const reported = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
    if (reported.includes(reason)) return false;
    if (reported.length >= MAX_REPORTS_PER_SESSION) return false;
    window.sessionStorage.setItem(
      REPORT_SESSION_KEY,
      JSON.stringify([...reported, reason]),
    );
    reportedReasons.add(reason);
    return true;
  } catch {
    reportedReasons.add(reason);
    return true;
  }
}
