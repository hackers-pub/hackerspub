import assert from "node:assert/strict";
import test from "node:test";
import { buildRobotsTxt } from "@hackerspub/models/robots";

test("web-next robots.txt GET returns the shared robots policy", async () => {
  Deno.env.set("ORIGIN", "https://hackers.pub");
  const { GET } = await import("./robots.txt.tsx");

  const response = GET({} as never);

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
