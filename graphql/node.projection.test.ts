import assert from "node:assert";
import test from "node:test";
import { execute, parse } from "graphql";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { actorTable, postTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  insertRemoteActor,
  insertRemotePost,
  makeGuestContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

test("Actor avatar requests do not read the actor's biography", async () => {
  await withRollback(async (tx) => {
    const actor = await insertRemoteActor(tx, {
      username: "actorprojection",
      name: "Actor Projection",
      host: "actorprojection.example",
    });
    await tx
      .update(actorTable)
      .set({
        bioHtml: `<p>${"Long biography. ".repeat(10000)}</p>`,
        avatarUrl: "https://actorprojection.example/avatar.png",
      })
      .where(eq(actorTable.id, actor.id));
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    try {
      const result = await execute({
        schema,
        document: parse(`query($id: UUID!) {
          actorByUuid(uuid: $id) { avatarUrl }
        }`),
        variableValues: { id: actor.id },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), {
        actorByUuid: {
          avatarUrl: "https://actorprojection.example/avatar.png",
        },
      });
      assert.ok(queries.length > 0);
      assert.ok(
        queries.every((query) => !query.includes('"bio_html"')),
        "Avatar cards must not transfer full actor biographies",
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("Post identity requests do not read post bodies", async () => {
  await withRollback(async (tx) => {
    const actor = await insertRemoteActor(tx, {
      username: "postprojection",
      name: "Post Projection",
      host: "postprojection.example",
    });
    const posts = [];
    for (const type of ["Note", "Article", "Question"] as const) {
      const post = await insertRemotePost(tx, {
        actorId: actor.id,
        contentHtml: `<p>${"Long post body. ".repeat(10000)}</p>`,
      });
      await tx.update(postTable).set({ type }).where(eq(postTable.id, post.id));
      posts.push({ ...post, type });
    }
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    try {
      const result = await execute({
        schema,
        document: parse(`query($ids: [ID!]!) {
          nodes(ids: $ids) { __typename ... on Post { uuid } }
        }`),
        variableValues: {
          ids: posts.map((post) => encodeGlobalID(post.type, post.id)),
        },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), {
        nodes: posts.map((post) => ({ __typename: post.type, uuid: post.id })),
      });
      assert.ok(queries.length > 0);
      assert.ok(
        queries.every((query) => !query.includes('"content_html"')),
        "Identity lookups must not transfer post bodies",
      );
      for (const post of posts) {
        const interfaceResult = await execute({
          schema,
          document: parse(`query($actorId: UUID!, $postId: UUID!) {
            actorByUuid(uuid: $actorId) {
              postByUuid(uuid: $postId) {
                __typename
                uuid
                engagementStats { replies }
              }
            }
          }`),
          variableValues: { actorId: actor.id, postId: post.id },
          contextValue: makeGuestContext(tx),
          onError: "NO_PROPAGATE",
        });
        assert.equal(interfaceResult.errors, undefined);
        assert.deepEqual(toPlainJson(interfaceResult.data), {
          actorByUuid: {
            postByUuid: {
              __typename: post.type,
              uuid: post.id,
              engagementStats: { replies: 0 },
            },
          },
        });
      }
      assert.ok(
        queries.every((query) => !query.includes('"content_html"')),
        "Interface lookups and engagement counters must not transfer post bodies",
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});
