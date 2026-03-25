import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BLOCKED_ROBOTS, buildRobotsTxt } from "./robots.ts";

Deno.test("buildRobotsTxt()", async (t) => {
  const body = buildRobotsTxt({
    sitemapUrl: "https://hackers.pub/sitemaps.xml",
  });

  await t.step("includes all blocked robots with a site-wide disallow", () => {
    for (const robot of BLOCKED_ROBOTS) {
      assertStringIncludes(
        body,
        `User-agent: ${robot}\nDisallow: /`,
      );
    }
  });

  await t.step("keeps the wildcard allow rule and sitemap entry", () => {
    assertStringIncludes(
      body,
      "User-agent: *\nAllow: /\nSitemap: https://hackers.pub/sitemaps.xml\n",
    );
  });

  await t.step("emits blocked robots before the wildcard section", () => {
    const wildcardIndex = body.indexOf("User-agent: *");
    assert(wildcardIndex > -1);

    for (const robot of BLOCKED_ROBOTS) {
      const robotIndex = body.indexOf(`User-agent: ${robot}`);
      assert(robotIndex > -1);
      assert(robotIndex < wildcardIndex);
    }
  });

  await t.step("uses a stable exact output format", () => {
    assertEquals(
      body,
      `User-agent: Amazonbot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: SemrushBot
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: GPTBot
Disallow: /

User-agent: YandexBot
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: *
Allow: /
Sitemap: https://hackers.pub/sitemaps.xml
`,
    );
  });
});
