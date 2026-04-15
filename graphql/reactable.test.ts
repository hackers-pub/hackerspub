import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import type { Transaction } from "@hackerspub/models/db";
import { reactionTable } from "@hackerspub/models/schema";
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

const reactorsQuery = parse(`
  query ReactorsQuery($id: ID!) {
    node(id: $id) {
      ... on Note {
        reactionGroups {
          ... on EmojiReactionGroup {
            emoji
            reactors(first: 10) {
              totalCount
              viewerHasReacted
              edges {
                node {
                  id
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
      const { noteId, viewerAccount, reactorIds } = await seedReactedNote(tx);

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
            reactors: {
              totalCount: number;
              viewerHasReacted: boolean;
              edges: { node: { id: string } }[];
            };
          }[];
        } | null;
      };

      const reactionGroup = data.node?.reactionGroups.find((group) =>
        group.emoji === "❤️"
      );
      assert(reactionGroup != null);
      assertEquals(reactionGroup.reactors.totalCount, 2);
      assertEquals(reactionGroup.reactors.viewerHasReacted, true);
      assertEquals(reactionGroup.reactors.edges.length, 2);
      assertEquals(
        reactionGroup.reactors.edges.map((edge) => edge.node.id).sort(),
        reactorIds.map((id) => encodeGlobalID("Actor", id)).sort(),
      );
    });
  },
});

async function seedReactedNote(tx: Transaction) {
  const timestamp = new Date("2026-04-15T00:00:00.000Z");

  await seedLocalInstance(tx);

  const author = await insertAccountWithActor(tx, {
    username: "author",
    name: "Author",
    email: "author@example.com",
  });
  const viewer = await insertAccountWithActor(tx, {
    username: "viewer",
    name: "Viewer",
    email: "viewer@example.com",
  });
  const other = await insertAccountWithActor(tx, {
    username: "other",
    name: "Other",
    email: "other@example.com",
  });

  const { post } = await insertNotePost(tx, {
    account: author.account,
    content: "Hello world",
    contentHtml: "<p>Hello world</p>",
    published: timestamp,
    updated: timestamp,
    reactionsCounts: { "❤️": 2 },
  });

  await tx.insert(reactionTable).values([
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
    reactorIds: [viewer.actor.id, other.actor.id],
  };
}
