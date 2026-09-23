import assert from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Guards the contract that keeps a reader's article page correct after a
 * translation is published or reviewed.
 *
 * Relay normalizes a returned object into a shared record only when the
 * selection carries its `id`. Without it, a mutation payload is stored under
 * the mutation's own path and the article route keeps rendering whatever it
 * fetched first, so a republished translation would keep its old title,
 * credit, freshness, or "translating…" placeholder until a full reload. These
 * assertions run against the compiled operation text, so removing a field from
 * a query or a payload fails here rather than silently going stale in a
 * browser.
 *
 * The generated artifacts cannot be imported directly under `node --test`:
 * they `import { ConcreteRequest } from "relay-runtime"` as a value import,
 * which type stripping cannot erase. Reading their operation text is the same
 * approach `graphql/builder.test.ts` uses.
 */
async function readOperationText(path: string): Promise<string> {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const match = source.match(/"text": "(?<text>(?:\\.|[^"\\])*)"/);
  assert.ok(match?.groups?.text, `No Relay operation text found in ${path}`);
  return JSON.parse(`"${match.groups.text}"`) as string;
}

/** The fields the article page renders for one language version. */
const READER_CONTENT_FIELDS = [
  "id",
  "language",
  "title",
  "originalLanguage",
  "beingTranslated",
  "provenance",
  "reviewState",
];

interface ContentSelection {
  /** The response key, so an aliased block can be told from a plain one. */
  readonly alias: string;
  readonly fields: readonly string[];
}

/**
 * The names selected directly inside each `contents { … }` block, with nested
 * blocks skipped, so a field that only exists on a sub-selection cannot be
 * mistaken for one on the content row itself.
 */
function contentSelections(operation: string): ContentSelection[] {
  const blocks: ContentSelection[] = [];
  const opener =
    /(?:^|\s)(?:(?<alias>[A-Za-z_]\w*): )?contents(?:\([^)]*\))? \{/g;
  for (const match of operation.matchAll(opener)) {
    let depth = 1;
    let index = match.index! + match[0].length;
    const fields: string[] = [];
    let line = "";
    while (depth > 0 && index < operation.length) {
      const char = operation[index++];
      if (char === "{") {
        depth++;
        line = "";
        continue;
      }
      if (char === "}") {
        depth--;
        line = "";
        continue;
      }
      if (char === "\n") {
        const name = line.trim();
        if (depth === 1 && /^[A-Za-z_]\w*$/.test(name)) fields.push(name);
        line = "";
        continue;
      }
      line += char;
    }
    blocks.push({ alias: match.groups?.alias ?? "contents", fields });
  }
  return blocks;
}

test("the article page query reads every field a translation credit needs", async () => {
  const operation = await readOperationText(
    "../routes/(root)/[handle]/[idOrYear]/[slug]/__generated__/SlugPageQuery.graphql.ts",
  );
  const selected = new Set(
    contentSelections(operation).flatMap((block) => block.fields),
  );
  assert.ok(selected.size > 0, "the query selects no article contents");
  for (const field of READER_CONTENT_FIELDS) {
    assert.ok(
      selected.has(field),
      `the article page query does not select \`${field}\` on a content row`,
    );
  }
  // The credit links to the translator's profile and is compared against the
  // author by account id, never by handle text.
  assert.match(operation, /translator \{/);
  assert.match(operation, /organizationAuthor \{/);
});

test("publishing a translation returns what the article page renders", async () => {
  const operation = await readOperationText(
    "../components/article-translations/__generated__/ArticleTranslationManagerPublishMutation.graphql.ts",
  );
  const blocks = contentSelections(operation);
  assert.equal(blocks.length, 1);
  const selected = new Set(blocks[0].fields);
  for (const field of READER_CONTENT_FIELDS) {
    assert.ok(
      selected.has(field),
      `the publish payload does not return \`${field}\`, so the article page ` +
        "would keep the previous value",
    );
  }
  assert.match(operation, /translator \{/);
});

test("acknowledging a revision returns the identified content row", async () => {
  const operation = await readOperationText(
    "../components/article-translations/__generated__/ArticleTranslationManagerAcknowledgeMutation.graphql.ts",
  );
  // Without `id` the cleared review state would never reach the article page's
  // copy of this row.
  assert.match(operation, /content \{\n\s*id\n\s*language\n\s*reviewState\n/);
});

test("editing the original returns the freshness of every other language", async () => {
  const operation = await readOperationText(
    "../routes/(root)/[handle]/[idOrYear]/[slug]/__generated__/edit_updateArticle_Mutation.graphql.ts",
  );
  // A source edit puts the other languages into "needs review", so the payload
  // has to return that state on the block that lists them, `allContents`.
  // Matching `reviewState` anywhere in the operation would also pass when some
  // other selection happens to carry it while `allContents` does not.
  const allContents = contentSelections(operation).find(
    (block) => block.alias === "allContents",
  );
  assert.ok(allContents, "the payload does not select every language version");
  for (const field of ["id", "reviewState"]) {
    assert.ok(
      allContents.fields.includes(field),
      `the update payload's \`allContents\` does not return \`${field}\`, so ` +
        "the reader page keeps showing the other languages as current",
    );
  }
});
