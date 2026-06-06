import assert from "node:assert";
import { describe, it } from "node:test";
import { BLOCKED_ROBOTS, buildRobotsTxt } from "./robots.ts";

describe("buildRobotsTxt()", () => {
  const body = buildRobotsTxt({
    sitemapUrl: "https://hackers.pub/sitemaps.xml",
  });

  it("includes all blocked robots with a site-wide disallow", () => {
    for (const robot of BLOCKED_ROBOTS) {
      assert.ok(body.includes(`User-agent: ${robot}\nDisallow: /`));
    }
  });

  it("keeps the wildcard allow rule and sitemap entry", () => {
    assert.ok(
      body.includes(
        "User-agent: *\nAllow: /\nSitemap: https://hackers.pub/sitemaps.xml\n",
      ),
    );
  });

  it("emits blocked robots before the wildcard section", () => {
    const wildcardIndex = body.indexOf("User-agent: *");
    assert.ok(wildcardIndex > -1);

    for (const robot of BLOCKED_ROBOTS) {
      const robotIndex = body.indexOf(`User-agent: ${robot}`);
      assert.ok(robotIndex > -1);
      assert.ok(robotIndex < wildcardIndex);
    }
  });

  it("uses a stable exact output format", () => {
    assert.deepEqual(
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
