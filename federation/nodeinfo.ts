import { count, sql } from "drizzle-orm";
import {
  accountTable,
  articleSourceTable,
  noteSourceTable,
} from "@hackerspub/models/schema";
import { builder } from "./builder.ts";
import metadata from "./package.json" with { type: "json" };

builder.setNodeInfoDispatcher("/nodeinfo/2.1", async (ctx) => {
  const { db } = ctx.data;
  // Reuse one article scan for all three aggregates and return the other
  // table counts in the same statement and database snapshot.
  const [usage] = await db
    .select({
      total: sql<number>`(SELECT count(*) FROM ${accountTable})`.mapWith(
        Number,
      ),
      activeMonth: sql<number>`count(DISTINCT ${articleSourceTable.accountId})
        FILTER (WHERE ${articleSourceTable.published} > CURRENT_TIMESTAMP - INTERVAL '1 month')`.mapWith(
        Number,
      ),
      activeHalfyear:
        sql<number>`count(DISTINCT ${articleSourceTable.accountId})
        FILTER (WHERE ${articleSourceTable.published} > CURRENT_TIMESTAMP - INTERVAL '6 months')`.mapWith(
          Number,
        ),
      localArticles: count(),
      localNotes:
        sql<number>`(SELECT count(*) FROM ${noteSourceTable})`.mapWith(Number),
    })
    .from(articleSourceTable);
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
        total: usage.total,
        activeMonth: usage.activeMonth,
        activeHalfyear: usage.activeHalfyear,
      },
      localComments: 0, // TODO
      localPosts: usage.localArticles + usage.localNotes,
    },
  };
});
