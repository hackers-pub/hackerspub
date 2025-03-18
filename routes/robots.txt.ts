import { define } from "../utils.ts";

export const handler = define.handlers((ctx) => {
  const body = `User-agent: *
Allow: /
Sitemap: ${ctx.state.canonicalOrigin}/sitemaps.xml`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=604800",
      "Access-Control-Allow-Origin": "*",
    },
  });
});
