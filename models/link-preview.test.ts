import assert from "node:assert";
import test from "node:test";
import { eq, inArray, sql } from "drizzle-orm";
import { persistPostLink, repairBrokenLinkPreviews } from "./link-preview.ts";
import { NEWS_PENALTY_DEMOTE } from "./news.ts";
import { postLinkTable, postTable } from "./schema.ts";
import { generateUuidV7 } from "./uuid.ts";
import {
  createFedCtx,
  insertAccountWithActor,
  insertNotePost,
  insertPostLink,
  insertRemoteActor,
  withRollback,
} from "../test/postgres.ts";

test("persistPostLink() reuses redirected links by authored URL", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "redirectcache",
      name: "Redirect Cache",
      email: "redirectcache@example.com",
    });
    const authoredUrl = "https://short.example/story";
    const destinationLink = await insertPostLink(tx, {
      url: "https://destination.example/article",
      title: "Destination",
    });
    await insertNotePost(tx, {
      account: author.account,
      link: { id: destinationLink.id, url: authoredUrl },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("The cached authored URL should not be fetched");
    };
    try {
      const link = await persistPostLink(createFedCtx(tx), authoredUrl);

      assert.equal(link?.id, destinationLink.id);
      assert.equal(link?.url, destinationLink.url);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

interface LinkLookupPlan {
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Rows Removed by Filter"?: number;
  "Actual Loops"?: number;
  Plans?: LinkLookupPlan[];
}

test("persistPostLink() supports long authored URLs and keeps fragments distinct", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "longauthoredlink",
      name: "Long Authored Link",
      email: "longauthoredlink@example.com",
    });
    const baseUrl = `https://short.example/${"long".repeat(1500)}`;
    const expected = await insertPostLink(tx, {
      url: "https://destination.example/long-authored",
    });
    const other = await insertPostLink(tx, {
      url: "https://destination.example/other-fragment",
    });
    await insertNotePost(tx, {
      account: author.account,
      link: { id: expected.id, url: `${baseUrl}#comments` },
    });
    await insertNotePost(tx, {
      account: author.account,
      link: { id: other.id, url: `${baseUrl}#other` },
      updated: new Date("2026-04-16T00:00Z"),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("The cached long URL should not be fetched");
    };
    try {
      const link = await persistPostLink(
        createFedCtx(tx),
        `${baseUrl}#comments`,
      );
      assert.equal(link?.id, expected.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("persistPostLink() bounds rows read for a frequently shared authored URL", async (t) => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "linklookupplan",
      name: "Link Lookup",
      email: "linklookupplan@example.com",
    });
    const authoredUrl = "https://short.example/shared-plan";
    const olderLink = await insertPostLink(tx, {
      url: "https://destination.example/old-plan",
    });
    const latestLink = await insertPostLink(tx, {
      url: "https://destination.example/new-plan",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      link: { id: olderLink.id, url: authoredUrl },
    });
    await tx.insert(postTable).values(
      Array.from({ length: 2000 }, (_, index) => {
        const id = generateUuidV7();
        return {
          ...post,
          id,
          noteSourceId: null,
          iri: `https://example.com/posts/${id}`,
          url: `https://example.com/posts/${id}`,
          updated: new Date(post.updated.getTime() + index + 1),
        };
      }),
    );
    await insertNotePost(tx, {
      account: author.account,
      link: { id: latestLink.id, url: authoredUrl },
      updated: new Date(post.updated.getTime() + 10000),
    });
    await tx.execute(sql`analyze ${postTable}`);
    const findFirst = tx.query.postTable.findFirst.bind(tx.query.postTable);
    let inspectedPosts = 0;
    let measured = 0;
    t.mock.method(
      tx.query.postTable,
      "findFirst",
      (options: Parameters<typeof findFirst>[0]) => {
        const query = findFirst(options);
        if (!options?.columns?.linkId) return query;
        return (async () => {
          const rows = await tx.execute(
            sql`explain (analyze, format json) ${query.getSQL()}`,
          );
          const plan = (
            rows[0]["QUERY PLAN"] as unknown as { Plan: LinkLookupPlan }[]
          )[0];
          measured++;
          const walk = (node: LinkLookupPlan): void => {
            if (node["Relation Name"] === "post")
              inspectedPosts +=
                ((node["Actual Rows"] ?? 0) +
                  (node["Rows Removed by Filter"] ?? 0)) *
                (node["Actual Loops"] ?? 0);
            for (const child of node.Plans ?? []) walk(child);
          };
          walk(plan.Plan);
          return await query;
        })();
      },
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("The cached link should not be fetched");
    };
    try {
      const link = await persistPostLink(createFedCtx(tx), authoredUrl);
      assert.equal(link?.id, latestLink.id);
      assert.equal(measured, 1);
      t.diagnostic(`Authored URL lookup inspected ${inspectedPosts} posts`);
      assert.ok(
        inspectedPosts > 0 && inspectedPosts <= 32,
        `Lookup inspected ${inspectedPosts} posts`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("repairBrokenLinkPreviews() splits malformed canonical URLs", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "repairlinkpreview",
      name: "Repair Link Preview",
      email: "repairlinkpreview@example.com",
    });
    const brokenHost = `repair-${crypto.randomUUID()}.example`;
    const brokenLink = await insertPostLink(tx, {
      url: `https://${brokenHost}/undefined`,
      title: "Video preview",
    });
    const sharedUrls = [
      "https://www.youtube.com/watch?v=first#comments",
      "https://www.youtube.com/watch?v=second&t=30#description",
    ];
    const posts = [];
    for (const sharedUrl of sharedUrls) {
      const inserted = await insertNotePost(tx, {
        account: author.account,
        contentHtml: `<p><a href="${sharedUrl}">Video</a></p>`,
        link: { id: brokenLink.id, url: brokenLink.url },
      });
      posts.push(inserted.post);
    }

    const result = await repairBrokenLinkPreviews(tx, {
      linkIds: [brokenLink.id],
    });

    assert.deepEqual(result, {
      brokenLinks: 1,
      repairedPosts: 2,
      unresolvedPosts: 0,
    });
    for (const [index, post] of posts.entries()) {
      const repaired = await tx.query.postTable.findFirst({
        where: { id: post.id },
        with: { link: true },
      });
      assert.ok(repaired?.link != null);
      assert.equal(repaired.linkUrl, sharedUrls[index]);
      const expectedResolved = new URL(sharedUrls[index]);
      expectedResolved.hash = "";
      assert.equal(repaired.link.url, expectedResolved.href);
      assert.equal(repaired.link.title, brokenLink.title);
    }
    assert.equal(
      await tx.query.postLinkTable.findFirst({
        where: { id: brokenLink.id },
      }),
      undefined,
    );
    const repairedLinks = await tx
      .select()
      .from(postLinkTable)
      .where(
        inArray(
          postLinkTable.url,
          sharedUrls.map((url) => {
            const parsed = new URL(url);
            parsed.hash = "";
            return parsed.href;
          }),
        ),
      );
    assert.equal(repairedLinks.length, 2);
  });
});

test("repairBrokenLinkPreviews() repairs embedded previews on Articles", async () => {
  await withRollback(async (tx) => {
    const host = `repair-article-${crypto.randomUUID()}.example`;
    const actor = await insertRemoteActor(tx, {
      username: "author",
      name: "Article Author",
      host,
    });
    const brokenLink = await insertPostLink(tx, {
      url: `https://${host}/undefined`,
      title: "Article preview",
    });
    const articleId = generateUuidV7();
    const sharedUrl = "https://docs.example/tutorial#configuration";
    await tx.insert(postTable).values({
      id: articleId,
      iri: `https://${host}/articles/${articleId}`,
      type: "Article",
      visibility: "followers",
      quotePolicy: "self",
      actorId: actor.id,
      contentHtml: `<p><a href="${sharedUrl}">Documentation</a></p>`,
      linkId: brokenLink.id,
      linkUrl: brokenLink.url,
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
    });

    const result = await repairBrokenLinkPreviews(tx, {
      linkIds: [brokenLink.id],
    });

    assert.deepEqual(result, {
      brokenLinks: 1,
      repairedPosts: 1,
      unresolvedPosts: 0,
    });
    const repaired = await tx.query.postTable.findFirst({
      where: { id: articleId },
      with: { link: true },
    });
    assert.ok(repaired?.link != null);
    assert.equal(repaired.linkUrl, sharedUrl);
    assert.equal(repaired.link.url, "https://docs.example/tutorial");
    assert.equal(repaired.link.title, brokenLink.title);
    assert.equal(
      await tx.query.postLinkTable.findFirst({
        where: { id: brokenLink.id },
      }),
      undefined,
    );
  });
});

test("repairBrokenLinkPreviews() preserves penalties on existing links", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "repairlinkpenalty",
      name: "Repair Link Penalty",
      email: "repairlinkpenalty@example.com",
    });
    const brokenHost = `repair-penalty-${crypto.randomUUID()}.example`;
    const brokenLink = await insertPostLink(tx, {
      url: `https://${brokenHost}/undefined`,
      title: "Malformed preview",
    });
    await tx
      .update(postLinkTable)
      .set({
        scorePenalty: NEWS_PENALTY_DEMOTE,
      })
      .where(eq(postLinkTable.id, brokenLink.id));

    const sharedUrl = `https://${brokenHost}/article#comments`;
    const existingLink = await insertPostLink(tx, {
      url: `https://${brokenHost}/article`,
      title: "Existing preview",
    });
    const { post } = await insertNotePost(tx, {
      account: author.account,
      contentHtml: `<p><a href="${sharedUrl}">Article</a></p>`,
      link: { id: brokenLink.id, url: brokenLink.url },
    });

    const result = await repairBrokenLinkPreviews(tx, {
      linkIds: [brokenLink.id],
    });

    assert.deepEqual(result, {
      brokenLinks: 1,
      repairedPosts: 1,
      unresolvedPosts: 0,
    });
    const repaired = await tx.query.postTable.findFirst({
      where: { id: post.id },
      with: { link: true },
    });
    assert.equal(repaired?.linkId, existingLink.id);
    assert.equal(repaired?.linkUrl, sharedUrl);
    assert.equal(repaired?.link?.title, existingLink.title);
    assert.equal(repaired?.link?.scorePenalty, NEWS_PENALTY_DEMOTE);
    assert.equal(
      await tx.query.postLinkTable.findFirst({
        where: { id: brokenLink.id },
      }),
      undefined,
    );
  });
});
