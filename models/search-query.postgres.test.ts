import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import type { RelationsFilter, Transaction } from "./db.ts";
import {
  getCensoredPostExclusionFilter,
  getPostVisibilityFilter,
} from "./post/visibility.ts";
import { postTable } from "./schema.ts";
import { parseQuery } from "./search.ts";
import { compileQuery, getSearchPostPage } from "./search-query.ts";
import { generateUuidV7, type Uuid } from "./uuid.ts";
import {
  insertAccountWithActor,
  insertRemotePost,
  withRollback,
} from "../test/postgres.ts";

function hash(token: string): string {
  const digest = createHash("md5").update(token).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
}

async function memberships(tx: Transaction, postId: Uuid) {
  return Array.from(
    await tx.execute<{
      tag_hash: string;
      published: Date;
      language: string | null;
      tuple: string;
    }>(sql`
      SELECT tag_hash, published, language, ctid::text AS tuple
      FROM post_hashtag WHERE post_id = ${postId} ORDER BY tag_hash
    `),
  );
}

test("hashtag memberships match PostgreSQL JSONB existence tokens", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "hashtagtokens",
      name: "Hashtag Tokens",
      email: "hashtagtokens@example.com",
    });
    const post = await insertRemotePost(tx, { actorId: author.actor.id });
    const long = "한".repeat(3000);
    const tokens = [
      "mixed",
      "MiXeD",
      "한국어🦋",
      long,
      "nested",
      "value",
      "7",
      "true",
    ];
    const shapes: unknown[] = [
      {},
      { MiXeD: "value", "한국어🦋": "url", [long]: "url" },
      ["mixed", "mixed", "한국어🦋", 7, true, { nested: "value" }, ["value"]],
      "mixed",
      7,
      true,
      null,
      { nested: { mixed: true } },
    ];
    for (const tags of shapes) {
      await tx.execute(
        sql`UPDATE post SET tags = ${JSON.stringify(tags)}::jsonb WHERE id = ${post.id}`,
      );
      const expected: string[] = [];
      for (const token of tokens) {
        const [row] = await tx.execute<{ present: boolean }>(sql`
          SELECT tags ? ${token} AS present FROM post WHERE id = ${post.id}
        `);
        if (row.present) expected.push(hash(token));
      }
      assert.deepEqual(
        (await memberships(tx, post.id)).map((row) => row.tag_hash),
        expected.sort(),
      );
    }
  });
});

test("hashtag memberships synchronize inserts, upserts, edits, cascades and rollback", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "hashtagsync",
      name: "Hashtag Sync",
      email: "hashtagsync@example.com",
    });
    const original = await insertRemotePost(tx, { actorId: author.actor.id });
    const id = generateUuidV7();
    const published = new Date("2026-04-16T00:00:00Z");
    const values = {
      ...original,
      id,
      iri: `https://remote.example/objects/${id}`,
      tags: { first: "url", second: "url" },
    };
    await tx.insert(postTable).values(values);
    const before = await memberships(tx, id);
    assert.equal(before.length, 2);
    await tx
      .insert(postTable)
      .values(values)
      .onConflictDoUpdate({
        target: postTable.id,
        set: {
          tags: values.tags,
          published: values.published,
          language: values.language,
        },
      });
    assert.deepEqual(
      await memberships(tx, id),
      before,
      "unchanged remote upserts must not rewrite derived rows",
    );
    // Raw SQL mimics old application writers that know nothing about the
    // derived column. Language-only edits (including NULL) must synchronize.
    for (const language of ["ko-KR", null, "en-US"]) {
      await tx.execute(
        sql`UPDATE post SET language = ${language} WHERE id = ${id}`,
      );
      const rows = await memberships(tx, id);
      assert.deepEqual(
        rows.map((row) => row.language),
        [language, language],
      );
      await tx.execute(
        sql`UPDATE post SET language = ${language} WHERE id = ${id}`,
      );
      assert.deepEqual(
        await memberships(tx, id),
        rows,
        "same language is a no-op",
      );
    }
    await tx.update(postTable).set({ published }).where(eq(postTable.id, id));
    assert.deepEqual(
      (await memberships(tx, id)).map((row) =>
        new Date(row.published).toISOString(),
      ),
      [published.toISOString(), published.toISOString()],
    );
    await assert.rejects(
      tx.transaction(async (savepoint) => {
        await savepoint
          .update(postTable)
          .set({ tags: { rolledback: "url" }, language: "ja" })
          .where(eq(postTable.id, id));
        assert.deepEqual(
          (await memberships(savepoint, id)).map((row) => row.tag_hash),
          [hash("rolledback")],
        );
        throw new Error("rollback hashtag edit");
      }),
      /rollback hashtag edit/,
    );
    assert.deepEqual(
      (await memberships(tx, id)).map((row) => row.tag_hash),
      [hash("first"), hash("second")].sort(),
    );
    assert.deepEqual(
      (await memberships(tx, id)).map((row) => row.language),
      ["en-US", "en-US"],
    );
    await assert.rejects(
      tx.transaction(async (savepoint) => {
        const movedId = generateUuidV7();
        await savepoint
          .update(postTable)
          .set({ id: movedId, language: "ja" })
          .where(eq(postTable.id, id));
        assert.deepEqual(await memberships(savepoint, id), []);
        const moved = await memberships(savepoint, movedId);
        assert.equal(moved.length, 2);
        assert.deepEqual(
          moved.map((row) => row.language),
          ["ja", "ja"],
        );
        throw new Error("rollback id and language edit");
      }),
      /rollback id and language edit/,
    );
    assert.deepEqual(
      (await memberships(tx, id)).map((row) => row.language),
      ["en-US", "en-US"],
    );
    const nextId = generateUuidV7();
    const nextPublished = new Date("2026-04-17T00:00:00Z");
    await tx
      .update(postTable)
      .set({
        id: nextId,
        tags: { replacement: "url" },
        published: nextPublished,
        language: "ko",
      })
      .where(eq(postTable.id, id));
    assert.deepEqual(await memberships(tx, id), []);
    const combined = await memberships(tx, nextId);
    assert.deepEqual(
      combined.map((row) => row.tag_hash),
      [hash("replacement")],
    );
    assert.equal(
      new Date(combined[0].published).toISOString(),
      nextPublished.toISOString(),
    );
    assert.equal(combined[0].language, "ko");
    await tx
      .update(postTable)
      .set({ tags: {} })
      .where(eq(postTable.id, nextId));
    assert.deepEqual(await memberships(tx, nextId), []);
    await tx
      .update(postTable)
      .set({ tags: { final: "url" } })
      .where(eq(postTable.id, nextId));
    await tx.delete(postTable).where(eq(postTable.id, nextId));
    assert.deepEqual(await memberships(tx, nextId), []);
  });
});

test("ordered hashtag pages equal the original compiler for compound expressions and cursors", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "hashtagcompare",
      name: "Hashtag Compare",
      email: "hashtagcompare@example.com",
    });
    const fixtures = [
      {
        tags: { popular: "url", sparse: "url" },
        language: "en",
        visibility: "public",
      },
      { tags: { popular: "url" }, language: "ko", visibility: "unlisted" },
      { tags: { sparse: "url" }, language: "en", visibility: "public" },
      { tags: { Popular: "url" }, language: "en", visibility: "public" },
      { tags: { popular: "url" }, language: "en", visibility: "direct" },
      { tags: { popular: "url" }, language: "ko-KR", visibility: "public" },
      { tags: { popular: "url" }, language: "en-US", visibility: "public" },
      { tags: { popular: "url" }, language: null, visibility: "public" },
    ] as const;
    const ids: Uuid[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const post = await insertRemotePost(tx, {
        actorId: author.actor.id,
        language: fixture.language ?? undefined,
        visibility: fixture.visibility,
        contentHtml: `<p>${index % 2 ? "other" : "needle"}</p>`,
        published: new Date(Date.UTC(2026, 3, 10 + index)),
      });
      await tx
        .update(postTable)
        .set({ tags: fixture.tags, language: fixture.language })
        .where(eq(postTable.id, post.id));
      ids.push(post.id);
    }
    // Simulate a hash collision or corrupt extra candidate. The source JSONB
    // remains authoritative even for a required positive tag.
    await tx.execute(
      sql`INSERT INTO post_hashtag(post_id, tag_hash, published, language) SELECT id, ${hash("popular")}::uuid, published, language FROM post WHERE id = ${ids[2]}`,
    );
    const queries = [
      "#POPULAR",
      "#popular #sparse",
      "#sparse #popular",
      "#popular needle",
      "#popular lang:en",
      "#popular author:hashtagcompare",
      "#popular -#sparse",
      "#popular OR #sparse",
      "-#popular",
      "#popular (needle OR other )",
      "#popular -(#sparse OR lang:ko )",
      "#popular (lang:ko OR lang:en )",
      "#popular (lang:ko OR needle )",
      "#popular lang:ko lang:en",
      "#popular lang:KO",
    ];
    for (const viewer of [null, author.actor]) {
      for (const query of queries) {
        for (const languages of [
          undefined,
          [],
          ["ko", "ko-KR"],
          ["ko", "ko-KR", "en", "en-US"],
          ["ja"],
        ]) {
          const expr = parseQuery(query);
          assert.ok(expr, query);
          const common: RelationsFilter<"postTable"> = {
            AND: [
              { id: { in: ids } },
              getPostVisibilityFilter(viewer),
              getCensoredPostExclusionFilter(viewer?.id),
              { sharedPostId: { isNull: true } },
              ...(viewer == null ? [{ visibility: "public" } as const] : []),
            ],
          };
          for (const until of [undefined, new Date("2026-04-12T00:00:00Z")]) {
            const expected: { id: Uuid; published: Date }[] =
              await tx.query.postTable.findMany({
                columns: { id: true, published: true },
                where: {
                  AND: [
                    common,
                    compileQuery(expr),
                    ...(languages == null
                      ? []
                      : [{ language: { in: languages } }]),
                    ...(until == null ? [] : [{ published: { lte: until } }]),
                  ],
                },
                orderBy: { published: "desc" },
                limit: 3,
              });
            assert.deepEqual(
              await getSearchPostPage(tx, expr, common, {
                limit: 3,
                until,
                languages,
              }),
              expected,
              `${query}, viewer=${viewer?.id ?? "guest"}, until=${until?.toISOString()}`,
            );
          }
        }
      }
    }
  });
});

test("hashtag language keys preserve long values, prefix collisions and Unicode boundaries", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "longhashtaglanguage",
      name: "Long hashtag language",
      email: "longhashtaglanguage@example.com",
    });
    const target = await insertRemotePost(tx, { actorId: author.actor.id });
    // Replies bypass the older top-level post indexes that also store full
    // language values. This input was accepted before the hashtag migration.
    const privateUse = Array.from({ length: 1000 }, (_, index) =>
      createHash("sha256").update(String(index)).digest("hex").slice(0, 8),
    ).join("-");
    const long = new Intl.Locale(`en-x-${privateUse}`).toString();
    const languages = [
      long,
      `${long}-another`,
      `${"a".repeat(63)}😀first`,
      `${"a".repeat(63)}😀second`,
    ];
    const ids: Uuid[] = [];
    for (const [index, language] of languages.entries()) {
      const post = await insertRemotePost(tx, {
        actorId: author.actor.id,
        replyTargetId: target.id,
        language,
        published: new Date(Date.UTC(2026, 3, index + 1)),
      });
      await tx
        .update(postTable)
        .set({ tags: { longlanguage461: "url" } })
        .where(eq(postTable.id, post.id));
      ids.push(post.id);
      assert.equal((await memberships(tx, post.id))[0].language, language);
    }
    const expr = parseQuery("#longlanguage461");
    assert.ok(expr);
    for (const [index, language] of languages.entries()) {
      const page = await getSearchPostPage(
        tx,
        expr,
        { id: { in: ids } },
        { limit: 2, languages: [language] },
      );
      assert.deepEqual(
        page.map(({ id }) => id),
        [ids[index]],
        "prefix collisions must recheck the full source language before limiting",
      );
    }
    await tx.execute(sql`UPDATE post SET language = NULL WHERE id = ${ids[0]}`);
    assert.equal((await memberships(tx, ids[0]))[0].language, null);
    await tx.execute(
      sql`UPDATE post SET language = ${long} WHERE id = ${ids[0]}`,
    );
    assert.equal((await memberships(tx, ids[0]))[0].language, long);
    assert.deepEqual(
      (
        await getSearchPostPage(tx, expr, {}, { limit: 2, languages: [long] })
      ).map(({ id }) => id),
      [ids[0]],
    );
  });
});
