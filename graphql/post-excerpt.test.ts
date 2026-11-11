import assert from "node:assert";
import test from "node:test";
import { postContentVariantTable, postTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { eq } from "drizzle-orm";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import {
  insertRemoteActor,
  insertRemotePost,
  makeGuestContext,
  withRollback,
} from "../test/postgres.ts";

const excerptQuery = parse(`
  query PostExcerpt($id: ID!) {
    node(id: $id) {
      ... on Post {
        excerpt
        contentVariant(language: "en") {
          excerpt
        }
      }
    }
  }
`);

interface ExcerptResult {
  excerpt: string;
  contentVariant: { excerpt: string };
}

async function readExcerpts(
  contextValue: ReturnType<typeof makeGuestContext>,
  id: string,
): Promise<ExcerptResult> {
  const result = await execute({
    schema,
    document: excerptQuery,
    variableValues: { id: encodeGlobalID("Note", id) },
    contextValue,
    onError: "NO_PROPAGATE",
  });
  assert.deepEqual(result.errors, undefined);
  const node = (result.data as { node: ExcerptResult | null }).node;
  assert.ok(node != null);
  return node;
}

for (const { label, summary, expected } of [
  { label: "empty", summary: "", expected: "Remote reply body" },
  { label: "whitespace", summary: " \t\n ", expected: "Remote reply body" },
  { label: "null", summary: null, expected: "Remote reply body" },
  { label: "HTML-only", summary: "<p> </p>", expected: "Remote reply body" },
  {
    label: "entity-only",
    summary: "<p>&nbsp;</p>",
    expected: "Remote reply body",
  },
  {
    label: "meaningful",
    summary: "A real summary",
    expected: "A real summary",
  },
]) {
  test(`remote post excerpts handle ${label} summaries`, async () => {
    await withRollback(async (tx) => {
      const actor = await insertRemoteActor(tx, {
        username: "excerptauthor",
        name: "Excerpt Author",
        host: "remote.example",
      });
      const contentHtml = "<p>Remote reply body</p>";
      const post = await insertRemotePost(tx, {
        actorId: actor.id,
        contentHtml,
      });
      await tx
        .update(postTable)
        .set({ summary })
        .where(eq(postTable.id, post.id));

      // A remote post without language alternatives uses its stored post row
      // as the default content variant.
      const guest = makeGuestContext(tx);
      const fallback = await readExcerpts(guest, post.id);
      assert.equal(fallback.excerpt, expected);
      assert.equal(fallback.contentVariant.excerpt, expected);

      await tx.insert(postContentVariantTable).values({
        id: generateUuidV7(),
        postId: post.id,
        language: "en",
        default: true,
        summary,
        contentHtml,
      });
      const variant = await readExcerpts(makeGuestContext(tx), post.id);
      assert.equal(variant.excerpt, expected);
      assert.equal(variant.contentVariant.excerpt, expected);

      // Falling back to the body must still respect moderation redaction.
      await tx
        .update(postTable)
        .set({ censored: new Date() })
        .where(eq(postTable.id, post.id));
      const censored = await readExcerpts(makeGuestContext(tx), post.id);
      assert.equal(censored.excerpt, "");
      assert.equal(censored.contentVariant.excerpt, "");
    });
  });
}

test("blank-summary excerpts omit the inline quote fallback", async () => {
  await withRollback(async (tx) => {
    const actor = await insertRemoteActor(tx, {
      username: "excerptquoteauthor",
      name: "Excerpt Quote Author",
      host: "remote.example",
    });
    const quoted = await insertRemotePost(tx, { actorId: actor.id });
    const contentHtml =
      '<p>My reply</p><p class="quote-inline">RE: quoted fallback</p>';
    const post = await insertRemotePost(tx, {
      actorId: actor.id,
      contentHtml,
      quotedPostId: quoted.id,
    });
    await tx
      .update(postTable)
      .set({ summary: "" })
      .where(eq(postTable.id, post.id));
    await tx.insert(postContentVariantTable).values({
      id: generateUuidV7(),
      postId: post.id,
      language: "en",
      default: true,
      summary: "",
      contentHtml,
    });

    const result = await readExcerpts(makeGuestContext(tx), post.id);
    assert.equal(result.excerpt, "My reply");
    assert.equal(result.contentVariant.excerpt, "My reply");
  });
});
