import { count, countDistinct, gt, sql } from "drizzle-orm";
import {
  accountTable,
  articleSourceTable,
  noteSourceTable,
} from "@hackerspub/models/schema";
import { builder } from "./builder.ts";
import metadata from "./deno.json" with { type: "json" };

function firstCount<K extends string>(
  rows: { [P in K]: number }[],
  key: K,
): number {
  return rows[0]?.[key] ?? 0;
}

builder.setNodeInfoDispatcher("/nodeinfo/2.1", async (ctx) => {
  const { db } = ctx.data;
  const total = firstCount(
    await db.select({ total: count() }).from(accountTable),
    "total",
  );
  const activeMonth = firstCount(
    await db.select({
      activeMonth: countDistinct(articleSourceTable.accountId),
    }).from(articleSourceTable).where(
      gt(
        articleSourceTable.published,
        sql`CURRENT_TIMESTAMP - INTERVAL '1 month'`,
      ),
    ),
    "activeMonth",
  );
  const activeHalfyear = firstCount(
    await db.select({
      activeHalfyear: countDistinct(articleSourceTable.accountId),
    }).from(articleSourceTable).where(
      gt(
        articleSourceTable.published,
        sql`CURRENT_TIMESTAMP - INTERVAL '6 months'`,
      ),
    ),
    "activeHalfyear",
  );
  const localArticles = firstCount(
    await db.select({ localArticles: count() }).from(articleSourceTable),
    "localArticles",
  );
  const localNotes = firstCount(
    await db.select({ localNotes: count() }).from(noteSourceTable),
    "localNotes",
  );
  return {
    software: {
      name: "hackerspub",
      version: metadata.version,
      homepage: new URL("https://hackers.pub/"),
      repository: new URL("https://github.com/hackers-pub/hackerspub"),
    },
    protocols: ["activitypub"],
    services: {
      inbound: [],
      outbound: ["atom1.0"],
    },
    usage: {
      users: {
        total,
        activeMonth,
        activeHalfyear,
      },
      localComments: 0, // TODO
      localPosts: localArticles + localNotes,
    },
  };
});
