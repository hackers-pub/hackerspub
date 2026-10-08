import assert from "node:assert";
import test from "node:test";
import { eq } from "drizzle-orm";
import type { Transaction } from "@hackerspub/models/db";
import { createOrganization } from "@hackerspub/models/organization";
import {
  accountTable,
  actorTable,
  customEmojiTable,
  postTable,
  reactionTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  makeUserContext,
  seedLocalInstance,
  withRollback,
} from "../test/postgres.ts";

interface ReactedNoteSeedResult {
  noteId: string;
  viewerAccount: Awaited<ReturnType<typeof insertAccountWithActor>>["account"];
  customEmojiId: string;
  reactors: { id: string; handle: string; avatarUrl: string }[];
}

test("reactor pages batch database queries across reaction groups", async () => {
  await withRollback(async (tx) => {
    const { noteId, viewerAccount, reactors } = await seedReactedNote(tx);
    const emojis = ["🚀", "🍰", "🎉", "👍", "💡", "🔥"];
    const rows = emojis.flatMap((emoji, group) =>
      reactors.map((reactor, index) => ({
        iri: `http://localhost/reactions/batch/${group}/${index}`,
        postId: noteId as typeof reactionTable.$inferInsert.postId,
        actorId: reactor.id as typeof reactionTable.$inferInsert.actorId,
        emoji,
        created: new Date("2026-04-15T00:00:00.000Z"),
      })),
    );
    await tx.insert(reactionTable).values(rows);
    await tx
      .update(postTable)
      .set({
        reactionsCounts: Object.fromEntries(emojis.map((emoji) => [emoji, 2])),
      })
      .where(eq(postTable.id, noteId as typeof postTable.$inferSelect.id));
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => {
      if (/from "reaction"(?: as "d0"| inner join)/.test(query))
        queries.push(query);
    };
    try {
      const result = await execute({
        schema,
        document: parse(`query($id: ID!) {
          node(id: $id) { ... on Post { reactionGroups {
            ... on EmojiReactionGroup { emoji }
            first: reactors(first: 1) {
              totalCount
              pageInfo { hasNextPage hasPreviousPage }
              edges { cursor node { id handle } }
            }
            last: reactors(last: 1) {
              pageInfo { hasNextPage hasPreviousPage }
              edges { cursor node { id handle } }
            }
          } } }
        }`),
        variableValues: { id: encodeGlobalID("Note", noteId) },
        contextValue: makeUserContext(tx, viewerAccount),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      interface Connection {
        totalCount?: number;
        pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean };
        edges: {
          cursor: string;
          node: { id: string; handle: string; account?: { id: string } | null };
        }[];
      }
      const data = result.data as unknown as {
        node: {
          reactionGroups: {
            emoji: string;
            first: Connection;
            last: Connection;
          }[];
        };
      };
      assert.equal(data.node.reactionGroups.length, emojis.length);
      for (const group of data.node.reactionGroups) {
        assert.equal(group.first.totalCount, 2);
        assert.equal(group.first.edges.length, 1);
        assert.equal(group.last.edges.length, 1);
        assert.equal(
          group.first.edges[0].node.id,
          encodeGlobalID("Actor", reactors[0].id),
        );
        assert.equal(
          group.last.edges[0].node.id,
          encodeGlobalID("Actor", reactors[1].id),
        );
        assert.deepEqual(group.first.pageInfo, {
          hasNextPage: true,
          hasPreviousPage: false,
        });
        assert.deepEqual(group.last.pageInfo, {
          hasNextPage: false,
          hasPreviousPage: true,
        });
      }
      assert.equal(queries.length, 3);
      queries.length = 0;
      const continued = await execute({
        schema,
        document: parse(`query($id: ID!, $after: String!, $before: String!) {
          node(id: $id) { ... on Post {
            a: reactionGroup(emoji: "🚀") {
              reactors(first: 1, after: $after) { edges { node { handle } } }
            }
            b: reactionGroup(emoji: "🍰") {
              reactors(last: 1, before: $before) { edges { node { id avatarUrl account { id } } } }
            }
            empty: reactionGroup(emoji: "🚀") {
              reactors(first: 1, after: $before) { edges { node { handle } } }
            }
          } }
        }`),
        variableValues: {
          id: encodeGlobalID("Note", noteId),
          after: data.node.reactionGroups.find((group) => group.emoji === "🚀")!
            .first.edges[0].cursor,
          before: data.node.reactionGroups.find(
            (group) => group.emoji === "🍰",
          )!.last.edges[0].cursor,
        },
        contextValue: makeUserContext(tx, viewerAccount),
        onError: "NO_PROPAGATE",
      });
      assert.equal(continued.errors, undefined);
      const continuedData = continued.data as unknown as {
        node: {
          a: { reactors: Connection };
          b: { reactors: Connection };
          empty: { reactors: Connection };
        };
      };
      assert.deepEqual(
        continuedData.node.a.reactors.edges.map((edge) => edge.node.handle),
        [reactors[1].handle],
      );
      assert.deepEqual(
        continuedData.node.b.reactors.edges.map((edge) => edge.node.id),
        [encodeGlobalID("Actor", reactors[0].id)],
      );
      assert.equal(
        continuedData.node.b.reactors.edges[0].node.account?.id,
        encodeGlobalID("Account", viewerAccount.id),
      );
      assert.deepEqual(continuedData.node.empty.reactors.edges, []);
      assert.equal(queries.length, 5);
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

const reactorsQuery = parse(`
  query ReactorsQuery($id: ID!) {
    node(id: $id) {
      ... on Post {
        reactionGroups {
          ... on EmojiReactionGroup {
            emoji
            reactors(first: 10) {
              totalCount
              viewerHasReacted
              edges {
                node {
                  id
                  handle
                  avatarUrl
                }
              }
            }
          }
          ... on CustomEmojiReactionGroup {
            reactors(first: 10) {
              edges {
                node {
                  handle
                  avatarUrl
                }
              }
            }
          }
        }
      }
    }
  }
`);

const viewerHasReactedPerspectiveQuery = parse(`
  query ViewerHasReactedPerspective($id: ID!, $actingAccountId: ID!) {
    node(id: $id) {
      ... on Post {
        reactionGroups {
          ... on EmojiReactionGroup {
            emoji
            reactors(first: 10) {
              personal: viewerHasReacted
              acting: viewerHasReacted(actingAccountId: $actingAccountId)
            }
          }
        }
      }
    }
  }
`);

test("ReactionGroup.reactors returns edges for first-page queries", async () => {
  await withRollback(async (tx) => {
    const { noteId, viewerAccount, reactors } = await seedReactedNote(tx);

    const result = await execute({
      schema,
      document: reactorsQuery,
      variableValues: {
        id: encodeGlobalID("Note", noteId),
      },
      contextValue: makeUserContext(tx, viewerAccount),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);

    const data = result.data as {
      node: {
        reactionGroups: {
          emoji?: string;
          reactors?: {
            totalCount?: number;
            viewerHasReacted?: boolean;
            edges: {
              node: { id?: string; handle: string; avatarUrl: string };
            }[];
          };
        }[];
      } | null;
    };

    const reactionGroup = data.node?.reactionGroups.find(
      (group) => group.emoji === "❤️",
    );
    assert.ok(reactionGroup != null);
    const reactorsConnection = reactionGroup.reactors;
    assert.ok(reactorsConnection != null);
    assert.deepEqual(reactorsConnection.totalCount, 2);
    assert.deepEqual(reactorsConnection.viewerHasReacted, true);
    assert.deepEqual(reactorsConnection.edges.length, 2);
    assert.deepEqual(
      reactorsConnection.edges.map((edge) => edge.node.id).sort(),
      reactors.map((reactor) => encodeGlobalID("Actor", reactor.id)).sort(),
    );
    for (const reactor of reactors) {
      const edgeNode:
        | { id?: string; handle: string; avatarUrl: string }
        | undefined = reactorsConnection.edges.find(
        (edge) => edge.node.handle === reactor.handle,
      )?.node;
      assert.ok(edgeNode != null);
      assert.deepEqual(edgeNode.avatarUrl, reactor.avatarUrl);
    }

    const customReactionGroup = data.node?.reactionGroups.find(
      (group) => group.emoji == null && group.reactors != null,
    );
    assert.ok(customReactionGroup != null);
    assert.ok(customReactionGroup.reactors != null);
    assert.deepEqual(customReactionGroup.reactors.edges.length, 1);
    assert.deepEqual(
      customReactionGroup.reactors.edges[0].node.handle,
      reactors[0].handle,
    );
    assert.deepEqual(
      customReactionGroup.reactors.edges[0].node.avatarUrl,
      reactors[0].avatarUrl,
    );
  });
});

test("ReactionGroup.reactors.viewerHasReacted can use an organization perspective", async () => {
  await withRollback(async (tx) => {
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);

    const author = await insertAccountWithActor(tx, {
      username: `reactorgauthor${suffix}`,
      name: "React Org Author",
      email: `reactorgauthor-${suffix}@example.com`,
    });
    const member = await insertAccountWithActor(tx, {
      username: `reactorgmember${suffix}`,
      name: "React Org Member",
      email: `reactorgmember-${suffix}@example.com`,
    });
    await tx
      .update(accountTable)
      .set({ leftInvitations: 1 })
      .where(eq(accountTable.id, member.account.id));
    const organization = await createOrganization(
      createFedCtx(tx),
      member.account,
      {
        username: `reactorg${suffix}`,
        name: "React Org",
        bio: "",
      },
    );
    const { post } = await insertNotePost(tx, {
      account: author.account,
      content: "Reacted by an organization",
      reactionsCounts: { "❤️": 1 },
    });
    await tx.insert(reactionTable).values({
      iri: `http://localhost/reactions/${generateUuidV7()}`,
      postId: post.id,
      actorId: organization.actor.id,
      emoji: "❤️",
      created: new Date("2026-04-15T00:00:01.000Z"),
    });

    const result = await execute({
      schema,
      document: viewerHasReactedPerspectiveQuery,
      variableValues: {
        id: encodeGlobalID("Note", post.id),
        actingAccountId: encodeGlobalID("Account", organization.id),
      },
      contextValue: makeUserContext(tx, member.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);
    const data = result.data as {
      node: {
        reactionGroups: {
          emoji?: string;
          reactors?: {
            personal: boolean;
            acting: boolean;
          };
        }[];
      } | null;
    };
    const group = data.node?.reactionGroups.find(
      (group) => group.emoji === "❤️",
    );
    assert.ok(group?.reactors != null);
    assert.deepEqual(group.reactors.personal, false);
    assert.deepEqual(group.reactors.acting, true);
  });
});

const customEmojiBatchQuery = parse(`
  query CustomEmojiBatchQuery($a: ID!, $b: ID!) {
    a: node(id: $a) {
      ... on Post {
        reactionGroups {
          ... on CustomEmojiReactionGroup {
            customEmoji {
              id
              name
              imageUrl
            }
          }
        }
      }
    }
    b: node(id: $b) {
      ... on Post {
        reactionGroups {
          ... on CustomEmojiReactionGroup {
            customEmoji {
              id
              name
              imageUrl
            }
          }
        }
      }
    }
  }
`);

test("CustomEmojiReactionGroup.customEmoji resolves the right emoji per post when batched", async () => {
  await withRollback(async (tx) => {
    const timestamp = new Date("2026-04-15T00:00:00.000Z");
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);

    await seedLocalInstance(tx);

    const author = await insertAccountWithActor(tx, {
      username: `author${suffix}`,
      name: "Author",
      email: `author-${suffix}@example.com`,
    });
    const reactor = await insertAccountWithActor(tx, {
      username: `reactor${suffix}`,
      name: "Reactor",
      email: `reactor-${suffix}@example.com`,
    });

    const partyId = generateUuidV7();
    const cakeId = generateUuidV7();
    await tx.insert(customEmojiTable).values([
      {
        id: partyId,
        iri: `http://localhost/emojis/${partyId}`,
        name: ":party:",
        imageUrl: `https://cdn.example/emoji/${partyId}.png`,
      },
      {
        id: cakeId,
        iri: `http://localhost/emojis/${cakeId}`,
        name: ":cake:",
        imageUrl: `https://cdn.example/emoji/${cakeId}.png`,
      },
    ]);

    const { post: postA } = await insertNotePost(tx, {
      account: author.account,
      content: "First",
      contentHtml: "<p>First</p>",
      published: timestamp,
      updated: timestamp,
      reactionsCounts: { [partyId]: 1 },
    });
    const { post: postB } = await insertNotePost(tx, {
      account: author.account,
      content: "Second",
      contentHtml: "<p>Second</p>",
      published: new Date(timestamp.getTime() + 1000),
      updated: new Date(timestamp.getTime() + 1000),
      reactionsCounts: { [cakeId]: 1 },
    });

    await tx.insert(reactionTable).values([
      {
        iri: `http://localhost/reactions/${generateUuidV7()}`,
        postId: postA.id,
        actorId: reactor.actor.id,
        customEmojiId: partyId,
        created: new Date(timestamp.getTime() + 100),
      },
      {
        iri: `http://localhost/reactions/${generateUuidV7()}`,
        postId: postB.id,
        actorId: reactor.actor.id,
        customEmojiId: cakeId,
        created: new Date(timestamp.getTime() + 1100),
      },
    ]);

    const result = await execute({
      schema,
      document: customEmojiBatchQuery,
      variableValues: {
        a: encodeGlobalID("Note", postA.id),
        b: encodeGlobalID("Note", postB.id),
      },
      contextValue: makeUserContext(tx, reactor.account),
      onError: "NO_PROPAGATE",
    });

    assert.deepEqual(result.errors, undefined);

    const data = result.data as {
      a: {
        reactionGroups: {
          customEmoji?: { id: string; name: string; imageUrl: string };
        }[];
      } | null;
      b: {
        reactionGroups: {
          customEmoji?: { id: string; name: string; imageUrl: string };
        }[];
      } | null;
    };

    const aEmoji = data.a?.reactionGroups
      .map((group) => group.customEmoji)
      .find((emoji) => emoji != null);
    const bEmoji = data.b?.reactionGroups
      .map((group) => group.customEmoji)
      .find((emoji) => emoji != null);

    assert.ok(aEmoji != null);
    assert.ok(bEmoji != null);
    assert.deepEqual(aEmoji.name, ":party:");
    assert.deepEqual(
      aEmoji.imageUrl,
      `https://cdn.example/emoji/${partyId}.png`,
    );
    assert.deepEqual(bEmoji.name, ":cake:");
    assert.deepEqual(
      bEmoji.imageUrl,
      `https://cdn.example/emoji/${cakeId}.png`,
    );
  });
});

const reactionGroupQuery = parse(`
  query ReactionGroupQuery(
    $id: ID!
    $emoji: String
    $customEmojiId: ID
  ) {
    node(id: $id) {
      ... on Post {
        reactionGroup(emoji: $emoji, customEmojiId: $customEmojiId) {
          __typename
          ... on EmojiReactionGroup {
            emoji
            reactors(first: 10) {
              totalCount
              edges {
                node { handle }
              }
            }
          }
          ... on CustomEmojiReactionGroup {
            customEmoji {
              name
            }
            reactors(first: 10) {
              totalCount
              edges {
                node { handle }
              }
            }
          }
        }
      }
    }
  }
`);

test("Post.reactionGroup returns a single emoji group when matched, null otherwise", async () => {
  await withRollback(async (tx) => {
    const { noteId, viewerAccount, reactors } = await seedReactedNote(tx);
    const id = encodeGlobalID("Note", noteId);

    // Matching standard emoji
    const heartResult = await execute({
      schema,
      document: reactionGroupQuery,
      variableValues: { id, emoji: "❤️", customEmojiId: null },
      contextValue: makeUserContext(tx, viewerAccount),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(heartResult.errors, undefined);
    const heartGroup = (
      heartResult.data as {
        node: {
          reactionGroup: {
            __typename: string;
            emoji?: string;
            reactors?: {
              totalCount: number;
              edges: { node: { handle: string } }[];
            };
          } | null;
        };
      }
    ).node.reactionGroup;
    assert.ok(heartGroup != null);
    assert.deepEqual(heartGroup.__typename, "EmojiReactionGroup");
    assert.deepEqual(heartGroup.emoji, "❤️");
    assert.deepEqual(heartGroup.reactors?.totalCount, 2);
    assert.deepEqual(
      heartGroup.reactors?.edges.map((e) => e.node.handle).sort(),
      reactors.map((r) => r.handle).sort(),
    );

    // Standard emoji with no reactions → null
    const rocketResult = await execute({
      schema,
      document: reactionGroupQuery,
      variableValues: { id, emoji: "🚀", customEmojiId: null },
      contextValue: makeUserContext(tx, viewerAccount),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(rocketResult.errors, undefined);
    assert.deepEqual(
      (rocketResult.data as { node: { reactionGroup: unknown } }).node
        .reactionGroup,
      null,
    );

    // Neither arg provided → null
    const emptyResult = await execute({
      schema,
      document: reactionGroupQuery,
      variableValues: { id, emoji: null, customEmojiId: null },
      contextValue: makeUserContext(tx, viewerAccount),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(emptyResult.errors, undefined);
    assert.deepEqual(
      (emptyResult.data as { node: { reactionGroup: unknown } }).node
        .reactionGroup,
      null,
    );

    // Both args provided → null (the resolver short-circuits ambiguous
    // requests rather than picking a winner).
    const bothResult = await execute({
      schema,
      document: reactionGroupQuery,
      variableValues: {
        id,
        emoji: "❤️",
        customEmojiId: encodeGlobalID(
          "CustomEmoji",
          (await tx.query.customEmojiTable.findMany({}))[0].id,
        ),
      },
      contextValue: makeUserContext(tx, viewerAccount),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(bothResult.errors, undefined);
    assert.deepEqual(
      (bothResult.data as { node: { reactionGroup: unknown } }).node
        .reactionGroup,
      null,
    );
  });
});

test("Post.reactionGroup returns a custom-emoji group when matched by id", async () => {
  await withRollback(async (tx) => {
    const {
      noteId,
      viewerAccount,
      customEmojiId: customEmojiUuid,
    } = await seedReactedNote(tx);
    const id = encodeGlobalID("Note", noteId);
    const customEmojiId = encodeGlobalID("CustomEmoji", customEmojiUuid);

    const customResult = await execute({
      schema,
      document: reactionGroupQuery,
      variableValues: { id, emoji: null, customEmojiId },
      contextValue: makeUserContext(tx, viewerAccount),
      onError: "NO_PROPAGATE",
    });
    assert.deepEqual(customResult.errors, undefined);
    const group = (
      customResult.data as {
        node: {
          reactionGroup: {
            __typename: string;
            customEmoji?: { name: string };
            reactors?: {
              totalCount: number;
              edges: { node: { handle: string } }[];
            };
          } | null;
        };
      }
    ).node.reactionGroup;
    assert.ok(group != null);
    assert.deepEqual(group.__typename, "CustomEmojiReactionGroup");
    assert.deepEqual(group.customEmoji?.name, ":party:");
    assert.deepEqual(group.reactors?.totalCount, 1);
    assert.deepEqual(group.reactors?.edges.length, 1);
  });
});

async function seedReactedNote(
  tx: Transaction,
): Promise<ReactedNoteSeedResult> {
  const timestamp = new Date("2026-04-15T00:00:00.000Z");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);

  await seedLocalInstance(tx);

  const author = await insertAccountWithActor(tx, {
    username: `author${suffix}`,
    name: "Author",
    email: `author-${suffix}@example.com`,
  });
  const viewer = await insertAccountWithActor(tx, {
    username: `viewer${suffix}`,
    name: "Viewer",
    email: `viewer-${suffix}@example.com`,
  });
  const other = await insertAccountWithActor(tx, {
    username: `other${suffix}`,
    name: "Other",
    email: `other-${suffix}@example.com`,
  });

  const viewerAvatarUrl = `https://cdn.example/avatars/viewer-${suffix}.png`;
  const otherAvatarUrl = `https://cdn.example/avatars/other-${suffix}.png`;
  const customEmojiId = generateUuidV7();
  await tx
    .update(actorTable)
    .set({ avatarUrl: viewerAvatarUrl })
    .where(eq(actorTable.id, viewer.actor.id));
  await tx
    .update(actorTable)
    .set({ avatarUrl: otherAvatarUrl })
    .where(eq(actorTable.id, other.actor.id));
  await tx.insert(customEmojiTable).values({
    id: customEmojiId,
    iri: `http://localhost/emojis/${customEmojiId}`,
    name: ":party:",
    imageUrl: `https://cdn.example/emoji/${customEmojiId}.png`,
  });

  const { post } = await insertNotePost(tx, {
    account: author.account,
    content: "Hello world",
    contentHtml: "<p>Hello world</p>",
    published: timestamp,
    updated: timestamp,
    reactionsCounts: { "❤️": 2, [customEmojiId]: 1 },
  });

  await tx.insert(reactionTable).values([
    {
      iri: `http://localhost/reactions/${generateUuidV7()}`,
      postId: post.id,
      actorId: viewer.actor.id,
      customEmojiId,
      created: new Date("2026-04-15T00:00:00.500Z"),
    },
    {
      iri: `http://localhost/reactions/${generateUuidV7()}`,
      postId: post.id,
      actorId: viewer.actor.id,
      emoji: "❤️",
      created: new Date("2026-04-15T00:00:01.000Z"),
    },
    {
      iri: `http://localhost/reactions/${generateUuidV7()}`,
      postId: post.id,
      actorId: other.actor.id,
      emoji: "❤️",
      created: new Date("2026-04-15T00:00:02.000Z"),
    },
  ]);

  return {
    noteId: post.id,
    viewerAccount: viewer.account,
    customEmojiId,
    reactors: [
      {
        id: viewer.actor.id,
        handle: viewer.actor.handle,
        avatarUrl: viewerAvatarUrl,
      },
      {
        id: other.actor.id,
        handle: other.actor.handle,
        avatarUrl: otherAvatarUrl,
      },
    ],
  };
}

test("reactor-count batching maps each post to its own total", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "reactbatchauthor",
      name: "React Batch Author",
      email: "reactbatchauthor@example.com",
    });
    const reactors: Awaited<ReturnType<typeof insertAccountWithActor>>[] = [];
    for (let i = 0; i < 3; i++) {
      reactors.push(
        await insertAccountWithActor(tx, {
          username: `reactbatchreactor${i}`,
          name: `React Batch Reactor ${i}`,
          email: `reactbatchreactor${i}@example.com`,
        }),
      );
    }
    // postA has three ❤️ reactors, postB has one. Resolved in one request so
    // the reactor-count DataLoader batches; each must get its own total.
    const { post: postA } = await insertNotePost(tx, {
      account: author.account,
      content: "A",
      reactionsCounts: { "❤️": 3 },
    });
    const { post: postB } = await insertNotePost(tx, {
      account: author.account,
      content: "B",
      reactionsCounts: { "❤️": 1 },
    });
    await tx.insert(reactionTable).values([
      ...reactors.map((r, i) => ({
        iri: `http://localhost/reactions/${generateUuidV7()}`,
        postId: postA.id,
        actorId: r.actor.id,
        emoji: "❤️",
        created: new Date(`2026-04-15T00:00:0${i + 1}.000Z`),
      })),
      {
        iri: `http://localhost/reactions/${generateUuidV7()}`,
        postId: postB.id,
        actorId: reactors[0].actor.id,
        emoji: "❤️",
        created: new Date("2026-04-15T00:00:09.000Z"),
      },
    ]);

    const query = parse(`
      query($a: ID!, $b: ID!) {
        a: node(id: $a) {
          ... on Post {
            reactionGroups {
              ... on EmojiReactionGroup { emoji reactors(first: 10) { totalCount } }
            }
          }
        }
        b: node(id: $b) {
          ... on Post {
            reactionGroups {
              ... on EmojiReactionGroup { emoji reactors(first: 10) { totalCount } }
            }
          }
        }
      }
    `);
    const result = await execute({
      schema,
      document: query,
      variableValues: {
        a: encodeGlobalID("Note", postA.id),
        b: encodeGlobalID("Note", postB.id),
      },
      contextValue: makeUserContext(tx, author.account),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    interface Groups {
      reactionGroups: { emoji?: string; reactors?: { totalCount: number } }[];
    }
    const data = result.data as unknown as { a: Groups; b: Groups };
    const heartA = data.a.reactionGroups.find((g) => g.emoji === "❤️");
    const heartB = data.b.reactionGroups.find((g) => g.emoji === "❤️");
    assert.equal(heartA?.reactors?.totalCount, 3);
    assert.equal(heartB?.reactors?.totalCount, 1);
  });
});
