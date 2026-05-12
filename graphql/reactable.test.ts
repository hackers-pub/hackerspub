import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { eq } from "drizzle-orm";
import type { Transaction } from "@hackerspub/models/db";
import {
  actorTable,
  customEmojiTable,
  reactionTable,
} from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
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

Deno.test({
  name: "ReactionGroup.reactors returns edges for first-page queries",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(result.errors, undefined);

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

      const reactionGroup = data.node?.reactionGroups.find((group) =>
        group.emoji === "❤️"
      );
      assert(reactionGroup != null);
      const reactorsConnection = reactionGroup.reactors;
      assert(reactorsConnection != null);
      assertEquals(reactorsConnection.totalCount, 2);
      assertEquals(reactorsConnection.viewerHasReacted, true);
      assertEquals(reactorsConnection.edges.length, 2);
      assertEquals(
        reactorsConnection.edges.map((edge) => edge.node.id).sort(),
        reactors.map((reactor) => encodeGlobalID("Actor", reactor.id)).sort(),
      );
      for (const reactor of reactors) {
        const node = reactorsConnection.edges.find((edge) =>
          edge.node.handle === reactor.handle
        )?.node;
        assert(node != null);
        assertEquals(node.avatarUrl, reactor.avatarUrl);
      }

      const customReactionGroup = data.node?.reactionGroups.find((group) =>
        group.emoji == null && group.reactors != null
      );
      assert(customReactionGroup != null);
      assert(customReactionGroup.reactors != null);
      assertEquals(customReactionGroup.reactors.edges.length, 1);
      assertEquals(
        customReactionGroup.reactors.edges[0].node.handle,
        reactors[0].handle,
      );
      assertEquals(
        customReactionGroup.reactors.edges[0].node.avatarUrl,
        reactors[0].avatarUrl,
      );
    });
  },
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

Deno.test({
  name:
    "CustomEmojiReactionGroup.customEmoji resolves the right emoji per post when batched",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(result.errors, undefined);

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

      assert(aEmoji != null);
      assert(bEmoji != null);
      assertEquals(aEmoji.name, ":party:");
      assertEquals(aEmoji.imageUrl, `https://cdn.example/emoji/${partyId}.png`);
      assertEquals(bEmoji.name, ":cake:");
      assertEquals(bEmoji.imageUrl, `https://cdn.example/emoji/${cakeId}.png`);
    });
  },
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

Deno.test({
  name:
    "Post.reactionGroup returns a single emoji group when matched, null otherwise",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
      assertEquals(heartResult.errors, undefined);
      const heartGroup = (heartResult.data as {
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
      }).node.reactionGroup;
      assert(heartGroup != null);
      assertEquals(heartGroup.__typename, "EmojiReactionGroup");
      assertEquals(heartGroup.emoji, "❤️");
      assertEquals(heartGroup.reactors?.totalCount, 2);
      assertEquals(
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
      assertEquals(rocketResult.errors, undefined);
      assertEquals(
        (rocketResult.data as { node: { reactionGroup: unknown } })
          .node.reactionGroup,
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
      assertEquals(emptyResult.errors, undefined);
      assertEquals(
        (emptyResult.data as { node: { reactionGroup: unknown } })
          .node.reactionGroup,
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
      assertEquals(bothResult.errors, undefined);
      assertEquals(
        (bothResult.data as { node: { reactionGroup: unknown } })
          .node.reactionGroup,
        null,
      );
    });
  },
});

Deno.test({
  name: "Post.reactionGroup returns a custom-emoji group when matched by id",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
      assertEquals(customResult.errors, undefined);
      const group = (customResult.data as {
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
      }).node.reactionGroup;
      assert(group != null);
      assertEquals(group.__typename, "CustomEmojiReactionGroup");
      assertEquals(group.customEmoji?.name, ":party:");
      assertEquals(group.reactors?.totalCount, 1);
      assertEquals(group.reactors?.edges.length, 1);
    });
  },
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
  await tx.update(actorTable)
    .set({ avatarUrl: viewerAvatarUrl })
    .where(eq(actorTable.id, viewer.actor.id));
  await tx.update(actorTable)
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
