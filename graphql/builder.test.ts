import assert from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { postTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { createYogaServer, schema } from "./mod.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

const postNodeQuery = parse(`
  query PostNode($id: ID!) {
    node(id: $id) { id }
  }
`);

test("node still reports database errors while loading posts", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: postNodeQuery,
      variableValues: { id: encodeGlobalID("Note", "not-a-uuid") },
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.ok(result.errors?.length);
    assert.match(result.errors[0].message, /Failed query:/);
    assert.equal(result.data?.node, null);
  });
});

for (const typename of ["Note", "Article", "Question"]) {
  test(`node returns null for a missing ${typename}`, async () => {
    await withRollback(async (tx) => {
      const result = await execute({
        schema,
        document: postNodeQuery,
        variableValues: { id: encodeGlobalID(typename, generateUuidV7()) },
        contextValue: makeGuestContext(tx),
        onError: "NO_PROPAGATE",
      });
      assert.equal(result.errors, undefined);
      assert.equal(result.data?.node, null);
    });
  });
}

test("node returns null after a previously visible post is deleted", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "deletednode",
      name: "Deleted Node",
      email: "deletednode@example.com",
    });
    const { post } = await insertNotePost(tx, { account: author.account });
    const variables = { id: encodeGlobalID("Note", post.id) };
    const visible = await execute({
      schema,
      document: postNodeQuery,
      variableValues: variables,
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(visible.errors, undefined);
    assert.ok(visible.data?.node);
    assert.equal((visible.data.node as { id: string }).id, variables.id);

    await tx.delete(postTable).where(eq(postTable.id, post.id));
    const deleted = await execute({
      schema,
      document: postNodeQuery,
      variableValues: variables,
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });
    assert.equal(deleted.errors, undefined);
    assert.equal(deleted.data?.node, null);
  });
});

const quotesNoteEngagementQueryPath = new URL(
  "../web-next/src/__generated__/quotesNoteEngagementQuery.graphql.ts",
  import.meta.url,
);
const notificationsPageQueryPath = new URL(
  "../web-next/src/__generated__/notificationsPageQuery.graphql.ts",
  import.meta.url,
);
const slugPageQueryPath = new URL(
  "../web-next/src/__generated__/SlugPageQuery.graphql.ts",
  import.meta.url,
);
const langPageQueryPath = new URL(
  "../web-next/src/__generated__/LangPageQuery.graphql.ts",
  import.meta.url,
);

async function readRelayOperationText(path: URL): Promise<string> {
  const source = await readFile(path, "utf8");
  const match = source.match(/"text": "(?<text>(?:\\.|[^"\\])*)"/);
  assert.ok(match?.groups?.text, `No Relay operation text found in ${path}`);
  return JSON.parse(`"${match.groups.text}"`);
}

test("anonymous complexity limits admit the web-next note quotes query", async () => {
  const query = await readRelayOperationText(quotesNoteEngagementQueryPath);
  await withRollback(async (tx) => {
    const yoga = createYogaServer();
    const response = await yoga.fetch(
      new Request("http://localhost/graphql?no-propagate=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          variables: {
            handle: "missing-user",
            noteId: generateUuidV7(),
          },
        }),
      }),
      makeGuestContext(tx),
    );
    const payload = (await response.json()) as {
      data?: { actorByHandle: unknown };
      errors?: { message: string }[];
    };

    assert.deepEqual(payload.errors, undefined);
    assert.deepEqual(payload.data, { actorByHandle: null });
  });
});

test("authenticated complexity limits admit the web-next notifications query", async () => {
  const query = await readRelayOperationText(notificationsPageQueryPath);
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "notificationuser",
      name: "Notification User",
      email: "notification@example.com",
    });
    const yoga = createYogaServer();
    const response = await yoga.fetch(
      new Request("http://localhost/graphql?no-propagate=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: {} }),
      }),
      makeUserContext(tx, account.account),
    );
    const payload = (await response.json()) as {
      data?: { viewer: unknown; webPushVapidPublicKey: unknown };
      errors?: { message: string }[];
    };

    assert.deepEqual(payload.errors, undefined);
    assert.ok(payload.data?.viewer != null);
  });
});

test("anonymous complexity limits admit the web-next notifications query", async () => {
  const query = await readRelayOperationText(notificationsPageQueryPath);
  await withRollback(async (tx) => {
    const yoga = createYogaServer();
    const response = await yoga.fetch(
      new Request("http://localhost/graphql?no-propagate=true", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: {} }),
      }),
      makeGuestContext(tx),
    );
    const payload = (await response.json()) as {
      data?: { viewer: unknown; webPushVapidPublicKey: string | null };
      errors?: { message: string }[];
    };

    assert.deepEqual(payload.errors, undefined);
    assert.equal(payload.data?.viewer, null);
    assert.ok(
      typeof payload.data?.webPushVapidPublicKey === "string" ||
        payload.data?.webPushVapidPublicKey === null,
    );
  });
});

// The article page renders translator credit and source-freshness state for
// every language version, so its `contents` selections grew. A signed-out
// visitor has to be able to run them: the freshness notice is server-rendered
// and must not depend on signing in.
for (const [name, path, variables] of [
  [
    "article page query",
    slugPageQueryPath,
    { handle: "@missing-user", idOrYear: "2026", slug: "missing-article" },
  ],
  [
    "article language page query",
    langPageQueryPath,
    {
      handle: "@missing-user",
      idOrYear: "2026",
      slug: "missing-article",
      language: "ko",
    },
  ],
] as const) {
  test(`anonymous complexity limits admit the web-next ${name}`, async () => {
    const query = await readRelayOperationText(path);
    await withRollback(async (tx) => {
      const yoga = createYogaServer();
      const response = await yoga.fetch(
        new Request("http://localhost/graphql?no-propagate=true", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query, variables }),
        }),
        makeGuestContext(tx),
      );
      const payload = (await response.json()) as {
        data?: { articleByYearAndSlug: unknown; viewer: unknown };
        errors?: { message: string }[];
      };

      assert.deepEqual(payload.errors, undefined);
      assert.equal(payload.data?.articleByYearAndSlug, null);
      assert.equal(payload.data?.viewer, null);
    });
  });
}
