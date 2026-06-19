import assert from "node:assert";
import test from "node:test";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { createYogaServer } from "./mod.ts";
import { makeGuestContext, withRollback } from "../test/postgres.ts";

const quotesNoteEngagementQueryPath = new URL(
  "../web-next/src/routes/(root)/[handle]/[noteId]/__generated__/quotesNoteEngagementQuery.graphql.ts",
  import.meta.url,
);

async function readRelayOperationText(path: URL): Promise<string> {
  const source = await Deno.readTextFile(path);
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
    const payload = await response.json() as {
      data?: { actorByHandle: unknown };
      errors?: { message: string }[];
    };

    assert.deepEqual(payload.errors, undefined);
    assert.deepEqual(payload.data, { actorByHandle: null });
  });
});
