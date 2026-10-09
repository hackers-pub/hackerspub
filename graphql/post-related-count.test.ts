import { postTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import assert from "node:assert/strict";
import test from "node:test";
import "./mod.ts";
import { countVisibleRelatedPosts } from "./post/core.ts";
import { postgres } from "../test/database.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  makeGuestContext,
  withRollback,
} from "../test/postgres.ts";

test("visible reply totals aggregate in SQL instead of transferring every id", async () => {
  await withRollback(async (tx) => {
    const { account, actor } = await insertAccountWithActor(tx, {
      username: "replycountaggregate",
      name: "Reply count aggregate",
      email: "replycountaggregate@example.com",
    });
    const { post: root } = await insertNotePost(tx, {
      account,
      content: "Reply count root",
    });
    await tx.insert(postTable).values(
      Array.from({ length: 302 }, (_, index) => {
        const id = generateUuidV7();
        return {
          id,
          iri: `https://remote.example/replies/${id}`,
          type: "Note" as const,
          actorId: actor.id,
          replyTargetId: root.id,
          contentHtml: "<p>A reply</p>",
          visibility: index === 300 ? ("direct" as const) : ("public" as const),
          censored: index === 301 ? new Date() : null,
          published: new Date(),
          updated: new Date(),
        };
      }),
    );
    const ctx = makeGuestContext(tx);
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    try {
      assert.equal(
        await countVisibleRelatedPosts(ctx, {}, "replyTargetId", root.id),
        300,
      );
      assert.equal(queries.length, 1);
      assert.match(
        queries[0],
        /^select count\(\*\) /i,
        "Reply totals must return a single aggregate row, not all reply IDs",
      );
      assert.equal(
        await countVisibleRelatedPosts(
          ctx,
          {},
          "replyTargetId",
          generateUuidV7(),
        ),
        0,
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});
