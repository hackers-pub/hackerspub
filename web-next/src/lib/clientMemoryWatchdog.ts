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

interface MemorySample {
  readonly sampledAt: number;
  readonly uptimeMs: number;
  readonly memoryApi: "measureUserAgentSpecificMemory" | "memory" | "none";
  readonly usedBytes?: number;
  readonly totalBytes?: number;
  readonly heapLimitBytes?: number;
  readonly domNodes: number;
  readonly timeElements: number;
  readonly route: string;
  readonly visibilityState: DocumentVisibilityState;
}

interface MemoryAlert {
  readonly reason: string;
  readonly level: "warning";
  readonly sample: MemorySample;
  readonly baseline: MemorySample;
  readonly previous: MemorySample;
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
    const baseline = samples[0] ?? current;
    const previous = samples.at(-1) ?? current;
    samples.push(current);
    if (samples.length > 12) samples.shift();

    const alert = detectMemoryAlert({
      sample: current,
      baseline,
      previous,
      sampleCount: samples.length,
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

async function collectMemorySample(): Promise<MemorySample> {
  const performance = window.performance as MemoryPerformance;
  const measured = await measureMemory(performance);

  return {
    sampledAt: Date.now(),
    uptimeMs: Math.round(performance.now()),
    route: window.location.pathname,
    visibilityState: document.visibilityState,
    domNodes: document.getElementsByTagName("*").length,
    timeElements: document.getElementsByTagName("time").length,
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
      sampleCount,
    };
  }

  return null;
}

function reportMemoryAlert(alert: MemoryAlert): void {
  if (!shouldReportMemoryAlert(alert.reason)) return;

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
        sample: alert.sample,
        baseline: alert.baseline,
        previous: alert.previous,
        sampleCount: alert.sampleCount,
      },
    },
  });
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
