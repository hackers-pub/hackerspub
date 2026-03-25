import { assertEquals } from "@std/assert";
import { buildRobotsTxt } from "@hackerspub/models/robots";

Deno.test("web-next robots.txt GET returns the shared robots policy", async () => {
  Deno.env.set("ORIGIN", "https://hackers.pub");
  const { GET } = await import("./robots.txt.tsx");

  const response = GET({} as never);

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
