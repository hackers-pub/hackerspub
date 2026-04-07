import process from "node:process";
import type { APIEvent } from "@solidjs/start/server";

const SITEMAP_QUERY = `
  query SitemapQuery {
    accounts {
      username
      updated
      actor {
        latestPostUpdated
      }
    }
  }
`;

export async function GET(event: APIEvent) {
  const origin = process.env.ORIGIN ?? new URL(event.request.url).origin;
  const response = await fetch(import.meta.env.VITE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query: SITEMAP_QUERY }),
  });

  if (!response.ok) {
    return new Response("Internal Server Error", { status: 500 });
  }

  // deno-lint-ignore no-explicit-any
  const { data, errors } = await response.json() as { data: any; errors: any };

  if (errors || !data?.accounts) {
    return new Response("Failed to fetch sitemap", { status: 500 });
  }

  const accounts: {
    username: string;
    updated: string;
    actor: { latestPostUpdated: string | null };
  }[] = data.accounts;

  let xml = `<?xml version="1.0" encoding="utf-8"?>\n`;
  xml += `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

  for (const account of accounts) {
    const lastmod = (account.actor?.latestPostUpdated != null &&
        new Date(account.actor.latestPostUpdated) > new Date(account.updated))
      ? account.actor.latestPostUpdated
      : account.updated;

    xml += `
  <sitemap>
    <loc>${new URL(`/@${account.username}/feed.xml`, origin).href}</loc>
    <lastmod>${lastmod}</lastmod>
  </sitemap>`;
  }

  xml += `\n</sitemapindex>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
}
