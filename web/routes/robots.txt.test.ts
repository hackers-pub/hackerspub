import assert from "node:assert/strict";
import test from "node:test";
import { buildRobotsTxt } from "@hackerspub/models/robots";
import { handler } from "./robots.txt.ts";

test("web robots.txt handler returns the shared robots policy", async () => {
  const response = await handler({
    state: { canonicalOrigin: "https://hackers.pub" },
  } as never);

  assert.deepEqual(
    response.headers.get("Content-Type"),
    "text/plain; charset=utf-8",
  );
  assert.deepEqual(
    response.headers.get("Cache-Control"),
    "public, max-age=604800",
  );
  assert.deepEqual(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(
    await response.text(),
    buildRobotsTxt({
      sitemapUrl: "https://hackers.pub/sitemaps.xml",
    }),
  );
});
