import assert from "node:assert/strict";
import test from "node:test";
import { MemoryKvStore } from "@fedify/fedify";
import { articleSourceTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { sql } from "drizzle-orm";
import { builder } from "./builder.ts";
import "./nodeinfo.ts";
import { postgres } from "../test/database.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

test("NodeInfo returns exact usage statistics in one database query", async () => {
  await withRollback(async (tx) => {
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = createFedCtx(tx).data;
    interface Usage {
      users: { total: number; activeMonth: number; activeHalfyear: number };
      localPosts: number;
      localComments: number;
    }
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    async function readUsage(): Promise<Usage> {
      const response = await federation.fetch(
        new Request("http://localhost/nodeinfo/2.1"),
        { contextData },
      );
      assert.equal(response.status, 200);
      return ((await response.json()) as { usage: Usage }).usage;
    }
    postgres.options.debug = (_connection, query) => {
      if (/from "(?:account|article_source|note_source)"/i.test(query)) {
        queries.push(query);
      }
    };
    try {
      const before = await readUsage();
      const beforeQueries = queries.length;
      const accounts: Awaited<ReturnType<typeof insertAccountWithActor>>[] = [];
      for (let index = 0; index < 5; index++) {
        accounts.push(
          await insertAccountWithActor(tx, {
            username: `nodeinfouser${index}`,
            name: `NodeInfo User ${index}`,
            email: `nodeinfouser${index}@example.com`,
          }),
        );
      }
      const publications = [
        { author: 0, age: sql`CURRENT_TIMESTAMP` },
        { author: 0, age: sql`CURRENT_TIMESTAMP - INTERVAL '1 day'` },
        { author: 0, age: sql`CURRENT_TIMESTAMP - INTERVAL '2 days'` },
        { author: 1, age: sql`CURRENT_TIMESTAMP - INTERVAL '2 months'` },
        { author: 2, age: sql`CURRENT_TIMESTAMP - INTERVAL '7 months'` },
        { author: 3, age: sql`CURRENT_TIMESTAMP - INTERVAL '1 month'` },
        { author: 3, age: sql`CURRENT_TIMESTAMP - INTERVAL '6 months'` },
      ];
      await tx.insert(articleSourceTable).values(
        publications.map(({ author, age }, index) => ({
          id: generateUuidV7(),
          accountId: accounts[author].account.id,
          slug: `nodeinfo-${index}`,
          published: age,
          publishedYear: sql`EXTRACT(year FROM (${age}))`,
        })),
      );
      await insertNotePost(tx, {
        account: accounts[4].account,
        content: "Only a note",
      });
      queries.length = 0;
      const after = await readUsage();
      assert.deepEqual(after, {
        users: {
          total: before.users.total + 5,
          activeMonth: before.users.activeMonth + 1,
          activeHalfyear: before.users.activeHalfyear + 3,
        },
        localPosts: before.localPosts + 8,
        localComments: 0,
      });
      assert.equal(beforeQueries, 1);
      assert.equal(queries.length, 1);
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});
