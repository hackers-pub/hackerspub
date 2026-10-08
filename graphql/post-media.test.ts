import assert from "node:assert/strict";
import test from "node:test";
import {
  accountTable,
  actorTable,
  postMediumTable,
  postTable,
} from "@hackerspub/models/schema";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import {
  execute,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  parse,
} from "graphql";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

test("post media field loading and authorization stay batched", async (t) => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "mediabatchauthor",
      name: "Media Batch Author",
      email: "mediabatchauthor@example.com",
    });
    const posts: Awaited<ReturnType<typeof insertNotePost>>[] = [];
    for (let index = 0; index < 6; index++) {
      const post = await insertNotePost(tx, {
        account: author.account,
        content: `Media ${index}`,
      });
      posts.push(post);
      await tx.insert(postMediumTable).values(
        [2, 0, 1].map((medium) => ({
          postId: post.post.id,
          index: medium,
          type: "image/png" as const,
          url: `https://example.com/${index}/${medium}.png`,
          alt: `Media ${index}/${medium}`,
          width: 100 + medium,
          height: 200 + medium,
          sensitive: medium === 1,
          thumbnailKey: medium === 0 ? null : `${post.post.id}/${medium}`,
        })),
      );
    }
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => {
      queries.push(query);
    };
    try {
      const queryCounts: number[] = [];
      for (const size of [1, 6]) {
        queries.length = 0;
        const result = await execute({
          schema,
          document: parse(`query($ids: [ID!]!) {
            nodes(ids: $ids) { ... on Post {
              media { id type url alt width height sensitive thumbnailUrl }
            } }
          }`),
          variableValues: {
            ids: posts
              .slice(0, size)
              .map((post) => encodeGlobalID("Note", post.post.id)),
          },
          contextValue: makeGuestContext(tx),
          onError: "NO_PROPAGATE",
        });
        assert.equal(result.errors, undefined);
        const data = result.data as unknown as {
          nodes: {
            media: {
              id: string;
              url: string;
              alt: string;
              width: number;
              height: number;
              sensitive: boolean;
              thumbnailUrl: string | null;
            }[];
          }[];
        };
        assert.equal(data.nodes.length, size);
        for (const [index, node] of data.nodes.entries()) {
          assert.equal(node.media.length, 3);
          for (const [medium, attachment] of node.media.entries()) {
            assert.equal(
              attachment.id,
              encodeGlobalID(
                "PostMedium",
                JSON.stringify([posts[index].post.id, medium]),
              ),
            );
            assert.equal(
              attachment.url,
              `https://example.com/${index}/${medium}.png`,
            );
            assert.equal(attachment.alt, `Media ${index}/${medium}`);
            assert.equal(attachment.width, 100 + medium);
            assert.equal(attachment.height, 200 + medium);
            assert.equal(attachment.sensitive, medium === 1);
            assert.equal(
              attachment.thumbnailUrl,
              medium === 0
                ? null
                : `http://localhost/media/${posts[index].post.id}/${medium}`,
            );
          }
        }
        queryCounts.push(queries.length);
      }
      assert(
        queryCounts.every((count) => count > 0 && count <= 4),
        `One and six posts emitted ${queryCounts.join(", ")} database queries`,
      );
      t.diagnostic(
        `One and six posts emitted ${queryCounts.join(", ")} queries`,
      );
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("batched media authorization preserves censorship restrictions", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "mediacensorauthor",
      name: "Media Author",
      email: "mediacensorauthor@example.com",
    });
    const moderator = await insertAccountWithActor(tx, {
      username: "mediacensormod",
      name: "Media Moderator",
      email: "mediacensormod@example.com",
    });
    const post = await insertNotePost(tx, {
      account: author.account,
      content: "Censored media",
    });
    await tx
      .update(accountTable)
      .set({ moderator: true })
      .where(eq(accountTable.id, moderator.account.id));
    await tx
      .update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, post.post.id));
    await tx.insert(postMediumTable).values(
      [0, 1, 2].map((index) => ({
        postId: post.post.id,
        index,
        type: "image/png" as const,
        url: `https://example.com/censored/${index}.png`,
      })),
    );
    const document = parse(`query($ids: [ID!]!) {
      nodes(ids: $ids) { ... on Post { media { url } } }
    }`);
    const ids = [encodeGlobalID("Note", post.post.id)];
    for (const context of [
      makeGuestContext(tx),
      makeUserContext(tx, author.account),
      makeUserContext(tx, { ...moderator.account, moderator: true }),
    ]) {
      const result = await execute({
        schema,
        document,
        variableValues: { ids },
        contextValue: context,
        onError: "NO_PROPAGATE",
      });
      const nodes = result.data?.nodes;
      if (context.account == null) {
        assert.equal(result.errors, undefined);
        assert.deepEqual(JSON.parse(JSON.stringify(nodes)), [{ media: [] }]);
      } else {
        assert.equal(result.errors, undefined);
        assert.deepEqual(JSON.parse(JSON.stringify(nodes)), [
          {
            media: [0, 1, 2].map((index) => ({
              url: `https://example.com/censored/${index}.png`,
            })),
          },
        ]);
      }
    }
  });
});

test("mixed parent moderation states remain distinct in one media authorization batch", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "mixedmediaauthor",
      name: "Media Author",
      email: "mixedmediaauthor@example.com",
    });
    const hiddenAuthor = await insertAccountWithActor(tx, {
      username: "mixedmediahidden",
      name: "Hidden Author",
      email: "mixedmediahidden@example.com",
    });
    const moderator = await insertAccountWithActor(tx, {
      username: "mixedmediamod",
      name: "Media Moderator",
      email: "mixedmediamod@example.com",
    });
    await tx
      .update(accountTable)
      .set({ moderator: true })
      .where(eq(accountTable.id, moderator.account.id));
    await tx
      .update(actorTable)
      .set({ suspended: new Date(), suspendedUntil: null })
      .where(eq(actorTable.id, hiddenAuthor.actor.id));
    const publicPost = await insertNotePost(tx, {
      account: author.account,
      content: "Public",
    });
    const censoredPost = await insertNotePost(tx, {
      account: author.account,
      content: "Censored",
    });
    const hiddenPost = await insertNotePost(tx, {
      account: hiddenAuthor.account,
      content: "Hidden",
    });
    await tx
      .update(postTable)
      .set({ censored: new Date() })
      .where(eq(postTable.id, censoredPost.post.id));
    const media = await tx
      .insert(postMediumTable)
      .values(
        [publicPost, censoredPost, hiddenPost].map((post) => ({
          postId: post.post.id,
          index: 0,
          type: "image/png" as const,
          url: `https://example.com/${post.post.id}.png`,
        })),
      )
      .returning();
    const byPostId = new Map(media.map((medium) => [medium.postId, medium]));
    const [secondCensoredMedium] = await tx
      .insert(postMediumTable)
      .values({
        postId: censoredPost.post.id,
        index: 1,
        type: "image/png",
        url: `https://example.com/${censoredPost.post.id}/second.png`,
      })
      .returning();
    const orderedMedia = [hiddenPost, censoredPost, publicPost].map((post) =>
      byPostId.get(post.post.id)!,
    );
    orderedMedia.push(secondCensoredMedium);
    // Exercise the production PostMedium type's authScopes directly, without
    // routing through Post.media's earlier redaction. The test root supplies
    // complete rows to isolate authorization from composite node-ID parsing.
    const testSchema = new GraphQLSchema({
      ...schema.toConfig(),
      query: new GraphQLObjectType({
        name: "MediaAuthorizationTestQuery",
        fields: {
          attachments: {
            type: new GraphQLList(
              schema.getType("PostMedium") as GraphQLObjectType,
            ),
            resolve: () => orderedMedia,
          },
        },
      }),
    });
    const document = parse("{ attachments { url } }");
    for (const [context, visible] of [
      [makeGuestContext(tx), [false, false, true, false]],
      [makeUserContext(tx, author.account), [false, true, true, true]],
      [
        makeUserContext(tx, { ...moderator.account, moderator: true }),
        [true, true, true, true],
      ],
    ] as const) {
      const result = await execute({
        schema: testSchema,
        document,
        contextValue: context,
        onError: "NO_PROPAGATE",
      });
      assert.equal(
        result.errors?.length ?? 0,
        visible.filter((value) => !value).length,
      );
      assert.deepEqual(
        JSON.parse(JSON.stringify(result.data?.attachments)),
        orderedMedia.map((medium, index) =>
          visible[index] ? { url: medium.url } : null,
        ),
      );
    }
  });
});
