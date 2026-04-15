import { assert } from "@std/assert/assert";
import { assertEquals } from "@std/assert/equals";
import { getActorStats, getPersistedActor } from "./actor.ts";
import { articleSourceTable, type NewPost, postTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  withRollback,
} from "../test/postgres.ts";

Deno.test({
  name: "getPersistedActor() loads local actor with account and instance",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const account = await insertAccountWithActor(tx, {
        username: "persistedactor",
        name: "Persisted Actor",
        email: "persistedactor@example.com",
      });

      const actor = await getPersistedActor(tx, account.actor.iri);

      assert(actor != null);
      assertEquals(actor.id, account.actor.id);
      assertEquals(actor.account?.id, account.account.id);
      assertEquals(actor.instance.host, "localhost");
      assertEquals(actor.successor, null);
    });
  },
});

Deno.test({
  name: "getActorStats() counts notes, replies, shares, and articles",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withRollback(async (tx) => {
      const author = await insertAccountWithActor(tx, {
        username: "actorstats",
        name: "Actor Stats",
        email: "actorstats@example.com",
      });
      const published = new Date("2026-04-15T00:00:00.000Z");
      const { post: note } = await insertNotePost(tx, {
        account: author.account,
        content: "Original note",
        published,
      });
      await insertNotePost(tx, {
        account: author.account,
        content: "Reply note",
        replyTargetId: note.id,
        published: new Date("2026-04-15T01:00:00.000Z"),
      });

      const articleSourceId = generateUuidV7();
      await tx.insert(articleSourceTable).values({
        id: articleSourceId,
        accountId: author.account.id,
        publishedYear: 2026,
        slug: "actor-stats-article",
        tags: [],
        allowLlmTranslation: false,
        published,
        updated: published,
      });

      const articleId = generateUuidV7();
      await tx.insert(postTable).values(
        {
          id: articleId,
          iri: `http://localhost/objects/${articleId}`,
          type: "Article",
          visibility: "public",
          actorId: author.actor.id,
          articleSourceId,
          contentHtml: "<p>Article body</p>",
          language: "en",
          tags: {},
          emojis: {},
          url:
            `http://localhost/@${author.account.username}/2026/actor-stats-article`,
          published,
          updated: published,
        } satisfies NewPost,
      );

      const sharedId = generateUuidV7();
      await tx.insert(postTable).values(
        {
          id: sharedId,
          iri: `http://localhost/objects/${sharedId}`,
          type: "Note",
          visibility: "public",
          actorId: author.actor.id,
          sharedPostId: note.id,
          contentHtml: "<p>Shared note</p>",
          language: "en",
          tags: {},
          emojis: {},
          url:
            `http://localhost/@${author.account.username}/shares/${sharedId}`,
          published: new Date("2026-04-15T02:00:00.000Z"),
          updated: new Date("2026-04-15T02:00:00.000Z"),
        } satisfies NewPost,
      );

      const stats = await getActorStats(tx, author.actor.id);

      assertEquals(stats, {
        total: 4,
        notes: 1,
        notesWithReplies: 2,
        shares: 1,
        articles: 1,
      });
    });
  },
});
