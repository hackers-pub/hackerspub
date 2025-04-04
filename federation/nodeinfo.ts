import { parseSemVer } from "@fedify/fedify";
import { count, countDistinct, gt, sql } from "drizzle-orm";
import metadata from "../deno.json" with { type: "json" };
import { federation } from "./federation.ts";
import { db } from "../db.ts";
import { accountTable, articleSourceTable } from "../models/schema.ts";

federation.setNodeInfoDispatcher("/nodeinfo/2.1", async (_ctx) => {
  const [{ total }] = await db.select({ total: count() }).from(accountTable);
  const [{ activeMonth }] = await db.select({
    activeMonth: countDistinct(articleSourceTable.accountId),
  }).from(articleSourceTable).where(
    gt(
      articleSourceTable.published,
      sql`CURRENT_TIMESTAMP - INTERVAL '1 month'`,
    ),
  );
  const [{ activeHalfyear }] = await db.select({
    activeHalfyear: countDistinct(articleSourceTable.accountId),
  }).from(articleSourceTable).where(
    gt(
      articleSourceTable.published,
      sql`CURRENT_TIMESTAMP - INTERVAL '6 months'`,
    ),
  );
  const [{ localPosts }] = await db.select({ localPosts: count() })
    .from(articleSourceTable);
  return {
    software: {
      name: "hackerspub",
      version: parseSemVer(metadata.version),
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
      localPosts,
    },
  };
});
