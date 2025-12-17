import type { APIEvent } from "@solidjs/start/server";
import { CANONICAL_ORIGIN_URL } from "~/lib/env.ts";

export function GET(_event: APIEvent) {
  const sitemapUrl = new URL("/sitemaps.xml", CANONICAL_ORIGIN_URL);
  const body = `User-agent: *
Allow: /
Sitemap: ${sitemapUrl}`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=604800",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
