import { assertEquals } from "@std/assert";
import { buildRobotsTxt } from "@hackerspub/models/robots";
import { handler } from "./robots.txt.ts";

Deno.test("web robots.txt handler returns the shared robots policy", async () => {
  const response = await handler({
    state: { canonicalOrigin: "https://hackers.pub" },
  } as never);

  assertEquals(
    response.headers.get("Content-Type"),
    "text/plain; charset=utf-8",
  );
  assertEquals(response.headers.get("Cache-Control"), "public, max-age=604800");
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    await response.text(),
    buildRobotsTxt({
      sitemapUrl: "https://hackers.pub/sitemaps.xml",
    }),
  );
});
