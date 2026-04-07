import process from "node:process";
import type { APIEvent } from "@solidjs/start/server";
import { fetchQuery, graphql } from "relay-runtime";
import { createEnvironment } from "../RelayEnvironment.tsx";
import type { sitemapsQuery } from "./__generated__/sitemapsQuery.graphql.ts";

export async function GET(event: APIEvent) {
  const origin = process.env.ORIGIN ?? new URL(event.request.url).origin;
  const response = await fetchQuery<sitemapsQuery>(
    createEnvironment(),
    graphql`
      query sitemapsQuery {
        accounts {
          username
          updated
          actor {
            latestPostUpdated
          }
        }
      }
    `,
    {},
  ).toPromise();

  if (!response?.accounts) {
    return new Response("Failed to fetch sitemap", { status: 500 });
  }

  const accounts = response.accounts;

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
