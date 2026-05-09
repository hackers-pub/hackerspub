import type { APIEvent } from "@solidjs/start/server";
import { buildRobotsTxt } from "@hackerspub/models/robots";
import { CANONICAL_ORIGIN_URL } from "~/lib/env.ts";

export function GET(_event: APIEvent) {
  const sitemapUrl = new URL("/sitemaps.xml", CANONICAL_ORIGIN_URL);
  const body = buildRobotsTxt({ sitemapUrl });

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=604800", // 7 days
      "Access-Control-Allow-Origin": "*",
    },
  });
}
