import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import {
  accountEmailTable,
  accountTable,
  actorTable,
  instanceTable,
  noteSourceTable,
  postTable,
  reactionTable,
} from "@hackerspub/models/schema";
import type { Transaction } from "@hackerspub/models/db";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import type { UserContext } from "./builder.ts";
import { db } from "./db.ts";
import { schema } from "./mod.ts";

type AuthenticatedAccount = NonNullable<UserContext["account"]>;

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
        contextValue: makeContext(tx, viewerAccount),
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

async function withRollback(run: (tx: Transaction) => Promise<void>) {
  let rolledBack = false;

  try {
    await db.transaction(async (tx) => {
      await run(tx);
      rolledBack = true;
      tx.rollback();
    });
  } catch (error) {
    if (!rolledBack) throw error;
  }
}

async function seedReactedNote(tx: Transaction) {
  const timestamp = new Date("2026-04-15T00:00:00.000Z");

  await tx.insert(instanceTable).values({
    host: "localhost",
    software: "hackerspub",
    softwareVersion: "test",
  }).onConflictDoNothing();

  const author = await insertAccountWithActor(tx, {
    username: "author",
    name: "Author",
    email: "author@example.com",
    iri: "http://localhost/@author",
    inboxUrl: "http://localhost/@author/inbox",
  });
  const viewer = await insertAccountWithActor(tx, {
    username: "viewer",
    name: "Viewer",
    email: "viewer@example.com",
    iri: "http://localhost/@viewer",
    inboxUrl: "http://localhost/@viewer/inbox",
  });
  const other = await insertAccountWithActor(tx, {
    username: "other",
    name: "Other",
    email: "other@example.com",
    iri: "http://localhost/@other",
    inboxUrl: "http://localhost/@other/inbox",
  });

  const noteSourceId = generateUuidV7();
  await tx.insert(noteSourceTable).values({
    id: noteSourceId,
    accountId: author.account.id,
    visibility: "public",
    content: "Hello world",
    language: "en",
    published: timestamp,
    updated: timestamp,
  });

  const noteId = generateUuidV7();
  await tx.insert(postTable).values({
    id: noteId,
    iri: `http://localhost/objects/${noteId}`,
    type: "Note",
    visibility: "public",
    actorId: author.actor.id,
    noteSourceId,
    contentHtml: "<p>Hello world</p>",
    language: "en",
    reactionsCounts: { "❤️": 2 },
    url: `http://localhost/@author/${noteSourceId}`,
    published: timestamp,
    updated: timestamp,
  });

  await tx.insert(reactionTable).values([
    {
      iri: `http://localhost/reactions/${generateUuidV7()}`,
      postId: noteId,
      actorId: viewer.actor.id,
      emoji: "❤️",
      created: new Date("2026-04-15T00:00:01.000Z"),
    },
    {
      iri: `http://localhost/reactions/${generateUuidV7()}`,
      postId: noteId,
      actorId: other.actor.id,
      emoji: "❤️",
      created: new Date("2026-04-15T00:00:02.000Z"),
    },
  ]);

  return {
    noteId,
    viewerAccount: viewer.account,
    reactorIds: [viewer.actor.id, other.actor.id],
  };
}

async function insertAccountWithActor(
  tx: Transaction,
  values: {
    username: string;
    name: string;
    email: string;
    iri: string;
    inboxUrl: string;
  },
) {
  const accountId = generateUuidV7();
  const actorId = generateUuidV7();
  const timestamp = new Date("2026-04-15T00:00:00.000Z");

  await tx.insert(accountTable).values({
    id: accountId,
    username: values.username,
    name: values.name,
    bio: "",
    leftInvitations: 0,
    created: timestamp,
    updated: timestamp,
  });

  await tx.insert(accountEmailTable).values({
    email: values.email,
    accountId,
    public: false,
    verified: timestamp,
    created: timestamp,
  });

  await tx.insert(actorTable).values({
    id: actorId,
    iri: values.iri,
    type: "Person",
    username: values.username,
    instanceHost: "localhost",
    handleHost: "localhost",
    accountId,
    name: values.name,
    inboxUrl: values.inboxUrl,
    sharedInboxUrl: "http://localhost/inbox",
    created: timestamp,
    updated: timestamp,
    published: timestamp,
  });

  const account = await tx.query.accountTable.findFirst({
    where: { id: accountId },
    with: {
      actor: true,
      emails: true,
      links: true,
    },
  });

  assert(account != null);

  return {
    account: account as AuthenticatedAccount,
    actor: account.actor,
  };
}

function makeContext(
  tx: Transaction,
  account: AuthenticatedAccount,
): UserContext {
  return {
    db: tx,
    kv: {} as UserContext["kv"],
    disk: {} as UserContext["disk"],
    email: {} as UserContext["email"],
    fedCtx: {} as UserContext["fedCtx"],
    request: new Request("http://localhost/graphql"),
    session: {
      id: generateUuidV7(),
      accountId: account.id,
      created: new Date("2026-04-15T00:00:00.000Z"),
    },
    account,
  };
}
