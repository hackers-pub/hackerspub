import assert from "node:assert/strict";
import test from "node:test";
import {
  noteSourceTable,
  organizationMembershipTable,
} from "@hackerspub/models/schema";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import type { UserContext } from "./builder.ts";
import { InvalidInputError, NotAuthorizedError } from "./error.ts";
import { schema } from "./mod.ts";
import { postgres } from "../test/database.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertRemotePost,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

// RQB reuses aliases in sibling joins: inspect only the note_source SELECT.
function bodyReads(queries: string[]): string[] {
  return queries.flatMap((query) =>
    Array.from(query.matchAll(/select ([^()]*?) from "note_source" as "d\d+"/g))
      .map((match) => match[1])
      .filter((columns) => columns.includes('"content"')),
  );
}

function rawRows(
  value: unknown,
): { rawContent: string | null; again: string | null }[] {
  if (value == null || typeof value !== "object") return [];
  if ("rawContent" in value) {
    return [value as { rawContent: string | null; again: string | null }];
  }
  return Object.values(value).flatMap(rawRows);
}

const nodeSourcesQuery = parse(`query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Note { rawContent again: rawContent } }
}`);

test("note Markdown stays lazy and owner reads are batched on node, profile, and thread paths", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "rawloaderowner",
      name: "Raw Owner",
      email: "rawloaderowner@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "rawloaderstranger",
      name: "Stranger",
      email: "rawloaderstranger@example.com",
    });
    const notes: Awaited<ReturnType<typeof insertNotePost>>[] = [];
    for (let index = 0; index < 6; index++) {
      notes.push(
        await insertNotePost(tx, {
          account: owner.account,
          content: `Owned _Markdown_ ${index}`,
          replyTargetId: notes[0]?.post.id,
        }),
      );
    }
    const ids = notes.map(({ post }) => encodeGlobalID("Note", post.id));
    const paths = [
      { document: nodeSourcesQuery, variableValues: { ids }, count: 6 },
      {
        document: parse(`query($actor: UUID!) { actorByUuid(uuid: $actor) {
          posts(first: 10) { edges { node { ... on Note { rawContent again: rawContent } } } }
        } }`),
        variableValues: { actor: owner.actor.id },
        count: 6,
      },
      {
        document: parse(`query($root: ID!) { node(id: $root) { ... on Post {
          descendants(first: 10) { edges { node { ... on Note { rawContent again: rawContent } } } }
        } } }`),
        variableValues: { root: ids[0] },
        count: 5,
      },
    ];
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    try {
      for (const path of paths) {
        for (const viewer of [undefined, stranger.account, owner.account]) {
          queries.length = 0;
          const result = await execute({
            schema,
            ...path,
            contextValue:
              viewer == null
                ? makeGuestContext(tx)
                : makeUserContext(tx, viewer),
            onError: "NO_PROPAGATE",
          });
          assert.equal(result.errors, undefined);
          const rows = rawRows(toPlainJson(result.data));
          assert.equal(rows.length, path.count);
          if (viewer?.id === owner.account.id) {
            assert.equal(
              bodyReads(queries).length,
              1,
              "all owned notes share one body batch",
            );
            for (const row of rows) {
              assert.match(row.rawContent!, /^Owned _Markdown_ [0-5]$/);
              assert.equal(row.again, row.rawContent);
            }
          } else {
            assert.equal(
              bodyReads(queries).length,
              0,
              "guests and other accounts never load Markdown",
            );
            assert.ok(
              rows.every(
                (row) => row.rawContent === null && row.again === null,
              ),
            );
          }
        }
      }
      const contextValue = makeUserContext(tx, owner.account);
      await execute({
        schema,
        document: nodeSourcesQuery,
        variableValues: { ids },
        contextValue,
      });
      await tx
        .update(noteSourceTable)
        .set({ content: "Fresh source" })
        .where(eq(noteSourceTable.id, notes[0].noteSourceId));
      const fresh = await execute({
        schema,
        document: nodeSourcesQuery,
        variableValues: { ids: [ids[0]] },
        contextValue: makeUserContext(tx, owner.account),
      });
      assert.equal(fresh.errors, undefined);
      assert.equal(rawRows(fresh.data)[0].rawContent, "Fresh source");
      await tx.transaction(async (savepoint) => {
        contextValue.db = savepoint;
        const retried = await execute({
          schema,
          document: nodeSourcesQuery,
          variableValues: { ids: [ids[0]] },
          contextValue,
        });
        assert.equal(retried.errors, undefined);
        assert.equal(rawRows(retried.data)[0].rawContent, "Fresh source");
      });
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("note source ownership keys and acting-account errors remain isolated", async () => {
  await withRollback(async (tx) => {
    const member = await insertAccountWithActor(tx, {
      username: "rawloadmember",
      name: "Member",
      email: "rawloadmember@example.com",
    });
    const stranger = await insertAccountWithActor(tx, {
      username: "rawloadnonmember",
      name: "Nonmember",
      email: "rawloadnonmember@example.com",
    });
    const organization = await insertAccountWithActor(tx, {
      username: "rawloadorg",
      name: "Organization",
      email: "rawloadorg@example.com",
      kind: "organization",
      type: "Organization",
    });
    await tx.insert(organizationMembershipTable).values({
      organizationAccountId: organization.account.id,
      memberAccountId: member.account.id,
      accepted: new Date(),
    });
    const personal = await insertNotePost(tx, {
      account: member.account,
      content: "Personal **source**",
    });
    const org = await insertNotePost(tx, {
      account: organization.account,
      content: "Organization **source**",
    });
    const ids = [personal, org].map(({ post }) =>
      encodeGlobalID("Note", post.id),
    );
    const orgId = encodeGlobalID("Account", organization.account.id);
    const queries: string[] = [];
    const originalDebug = postgres.options.debug;
    postgres.options.debug = (_connection, query) => queries.push(query);
    try {
      const result = await execute({
        schema,
        document: parse(`query($ids: [ID!]!, $org: ID!, $personal: ID!) {
          nodes(ids: $ids) { ... on Note {
            personal: rawContent explicitPersonal: rawContent(actingAccountId: $personal)
            organization: rawContent(actingAccountId: $org)
          } }
        }`),
        variableValues: {
          ids,
          org: orgId,
          personal: encodeGlobalID("Account", member.account.id),
        },
        contextValue: makeUserContext(tx, member.account),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      assert.deepEqual(toPlainJson(result.data), {
        nodes: [
          {
            personal: "Personal **source**",
            explicitPersonal: "Personal **source**",
            organization: null,
          },
          {
            personal: null,
            explicitPersonal: null,
            organization: "Organization **source**",
          },
        ],
      });
      assert.equal(
        bodyReads(queries).length,
        2,
        "one batch per authorized account, never per alias",
      );

      const actingQuery = parse(
        `query($id: ID!, $acting: ID!) { node(id: $id) { ... on Note { rawContent(actingAccountId: $acting) } } }`,
      );
      for (const [acting, expectedError] of [
        [orgId, NotAuthorizedError],
        [ids[0], InvalidInputError],
      ] as const) {
        queries.length = 0;
        const invalid = await execute({
          schema,
          document: actingQuery,
          variableValues: { id: ids[1], acting },
          contextValue: makeUserContext(tx, stranger.account),
          onError: "NO_PROPAGATE",
        });
        assert.ok(invalid.errors?.[0].originalError instanceof expectedError);
        assert.equal(bodyReads(queries).length, 0);
      }

      const remote = await insertRemotePost(tx, { actorId: member.actor.id });
      const share = await insertRemotePost(tx, {
        actorId: member.actor.id,
        sharedPostId: remote.id,
      });
      for (const [id, contextValue] of [
        [ids[0], makeGuestContext(tx)],
        [
          encodeGlobalID("Note", remote.id),
          makeUserContext(tx, member.account),
        ],
        [encodeGlobalID("Note", share.id), makeUserContext(tx, member.account)],
      ] as const) {
        queries.length = 0;
        const empty = await execute({
          schema,
          document: actingQuery,
          variableValues: { id, acting: ids[0] },
          contextValue,
          onError: "NO_PROPAGATE",
        });
        assert.equal(
          empty.errors,
          undefined,
          "source-less notes and guests short-circuit invalid acting IDs",
        );
        assert.deepEqual(toPlainJson(empty.data), {
          node: { rawContent: null },
        });
        assert.equal(bodyReads(queries).length, 0);
      }
    } finally {
      postgres.options.debug = originalDebug;
    }
  });
});

test("two updates of the same note return fresh Markdown in each mutation payload", async () => {
  await withRollback(async (tx) => {
    const owner = await insertAccountWithActor(tx, {
      username: "rawloadupdate",
      name: "Owner",
      email: "rawloadupdate@example.com",
    });
    const note = await insertNotePost(tx, {
      account: owner.account,
      content: "Original",
    });
    const result = await execute({
      schema,
      document: parse(`mutation($id: ID!) {
        first: updateNote(input: {noteId: $id, content: "First **edit**"}) {
          __typename ... on UpdateNotePayload { note { rawContent } }
        }
        second: updateNote(input: {noteId: $id, content: "Second _edit_"}) {
          __typename ... on UpdateNotePayload { note { rawContent } }
        }
      }`),
      variableValues: { id: encodeGlobalID("Note", note.post.id) },
      contextValue: makeUserContext(tx, owner.account, {
        fedCtx: {
          ...createFedCtx(tx),
          request: new Request("http://localhost/graphql"),
        } as UserContext["fedCtx"],
      }),
      onError: "NO_PROPAGATE",
    });
    assert.equal(result.errors, undefined);
    assert.deepEqual(toPlainJson(result.data), {
      first: {
        __typename: "UpdateNotePayload",
        note: { rawContent: "First **edit**" },
      },
      second: {
        __typename: "UpdateNotePayload",
        note: { rawContent: "Second _edit_" },
      },
    });
  });
});
