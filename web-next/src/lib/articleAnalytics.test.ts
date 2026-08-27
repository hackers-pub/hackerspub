import assert from "node:assert";
import test from "node:test";

import {
  articleAnalyticsRangeParam,
  latestAnalyticsUpdate,
  parseArticleAnalyticsRange,
  trendBarHeight,
} from "./articleAnalytics.ts";

test("article analytics ranges use 30 days as the canonical default", () => {
  assert.equal(parseArticleAnalyticsRange(undefined), "THIRTY_DAYS");
  assert.equal(parseArticleAnalyticsRange("unexpected"), "THIRTY_DAYS");
  assert.equal(parseArticleAnalyticsRange(["7", "90"]), "SEVEN_DAYS");
  assert.equal(articleAnalyticsRangeParam("THIRTY_DAYS"), undefined);
});

test("article analytics ranges round-trip through URL parameters", () => {
  for (const range of ["SEVEN_DAYS", "NINETY_DAYS", "ALL"] as const) {
    assert.equal(
      parseArticleAnalyticsRange(articleAnalyticsRangeParam(range)),
      range,
    );
  }
});

test("trend bars preserve visible non-zero values", () => {
  assert.equal(trendBarHeight(0, 10), 0);
  assert.equal(trendBarHeight(1, 100), 4);
  assert.equal(trendBarHeight(25, 100), 25);
  assert.equal(trendBarHeight(10, 10), 100);
});

test("latestAnalyticsUpdate returns the newest available timestamp", () => {
  assert.equal(latestAnalyticsUpdate(null, null), null);
  assert.equal(
    latestAnalyticsUpdate("2026-08-26T12:00:00Z", null),
    "2026-08-26T12:00:00Z",
  );
  assert.equal(
    latestAnalyticsUpdate(null, "2026-08-27T12:00:00Z"),
    "2026-08-27T12:00:00Z",
  );
  assert.equal(
    latestAnalyticsUpdate("2026-08-26T12:00:00Z", "2026-08-27T12:00:00Z"),
    "2026-08-27T12:00:00Z",
  );
});
