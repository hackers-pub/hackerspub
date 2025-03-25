import { create } from "xmlbuilder2";
import { db } from "../db.ts";
import { define } from "../utils.ts";

export const handler = define.handlers(async (ctx) => {
  const accounts = await db.query.accountTable.findMany({
    columns: { username: true, created: true, updated: true },
    with: {
      actor: {
        columns: {},
        with: {
          posts: {
            columns: { updated: true },
            orderBy: { updated: "desc" },
            limit: 1,
          },
        },
      },
    },
  });
  const xml = create({ version: "1.0", encoding: "utf-8" }, {
    sitemapindex: {
      "@xmlns": "http://www.sitemaps.org/schemas/sitemap/0.9",
      sitemap: accounts.map((account) => ({
        loc: `${ctx.state.canonicalOrigin}/@${account.username}/feed.xml`,
        lastmod: (account.actor.posts.length > 0
          ? account.actor.posts[0].updated
          : account.updated).toISOString(),
      })),
    },
  });
  return new Response(xml.end({ prettyPrint: true }), {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
});
