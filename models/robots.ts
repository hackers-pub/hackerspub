export const BLOCKED_ROBOTS = [
  "Amazonbot",
  "ClaudeBot",
  "SemrushBot",
  "Bytespider",
  "GPTBot",
  "YandexBot",
  "CCBot",
] as const;

export interface BuildRobotsTxtOptions {
  sitemapUrl: string | URL;
}

export function buildRobotsTxt(
  { sitemapUrl }: BuildRobotsTxtOptions,
): string {
  const lines = BLOCKED_ROBOTS.flatMap((userAgent) => [
    `User-agent: ${userAgent}`,
    "Disallow: /",
    "",
  ]);

  lines.push(
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${sitemapUrl}`,
  );

  return `${lines.join("\n")}\n`;
}
