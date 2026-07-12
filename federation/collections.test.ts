import assert from "node:assert";
import test from "node:test";
import type { Context } from "@fedify/fedify";
import { MemoryKvStore } from "@fedify/fedify";
import { Question } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import {
  actorTable,
  articleSourceTable,
  customEmojiTable,
  postTable,
  reactionTable,
} from "@hackerspub/models/schema";
import type { Uuid } from "@hackerspub/models/uuid";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { eq } from "drizzle-orm";
import { builder } from "./builder.ts";
import { toFeaturedCollectionItem } from "./collections.ts";
import "./objects.ts";
import {
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
  insertNotePost,
  insertRemoteActor,
  services,
  withRollback,
} from "../test/postgres.ts";

test("outbox root omits totalItems without counting posts", async () => {
  await withRollback(async (tx) => {
    const account = await insertAccountWithActor(tx, {
      username: "outboxrootcount",
      name: "Outbox Root Count",
      email: "outboxrootcount@example.com",
    });
    const db = new Proxy(tx, {
      get(target: Transaction, property, receiver) {
        if (property === "select") {
          return () => {
            throw new Error("outbox root should not count posts");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Transaction;
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = {
      db,
      kv: createTestKv().kv,
      disk: createTestDisk(),
      models: {} as ContextData["models"],
      services,
    };

    const response = await federation.fetch(
      new Request(`http://localhost/ap/actors/${account.account.id}/outbox`, {
        headers: { Accept: "application/activity+json" },
      }),
      { contextData },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.totalItems, null);
    assert.ok(body.first != null);
  });
});

test("toFeaturedCollectionItem() returns importable Question posts", async () => {
  const accountId = "00000000-0000-0000-0000-000000000001" as Uuid;
  const ctx = {
    getActorUri: (identifier: string) =>
      new URL(`https://example.com/ap/actors/${identifier}`),
    getFollowersUri: (identifier: string) =>
      new URL(`https://example.com/ap/actors/${identifier}/followers`),
  } as unknown as Context<ContextData>;
  const item = toFeaturedCollectionItem(ctx, {
    iri: "https://example.com/objects/question",
    type: "Question",
    actor: { accountId },
    contentHtml:
      '<h2 id="poll-question">Poll question<a class="header-anchor" href="#poll-question"></a></h2>',
    language: "en",
    name: "Poll question",
    poll: {
      multiple: false,
      votersCount: 3,
      ends: new Date("2026-05-01T00:00:00Z"),
      options: [
        { index: 0, title: "Yes", votesCount: 2 },
        { index: 1, title: "No", votesCount: 1 },
      ],
    },
    published: new Date("2026-04-01T00:00:00Z"),
    sensitive: false,
    summary: null,
    updated: new Date("2026-04-01T00:00:00Z"),
    url: "https://example.com/@alice/polls/1",
    visibility: "public",
  });

  assert.ok(item instanceof Question);
  assert.equal(
    item.attributionId?.href,
    "https://example.com/ap/actors/00000000-0000-0000-0000-000000000001",
  );
  assert.equal(
    item.content?.toString(),
    '<h2 id="poll-question">Poll question</h2>',
  );
  assert.equal(item.name?.toString(), "Poll question");
  const options = await Array.fromAsync(item.getExclusiveOptions());
  assert.deepEqual(options.map((option) => option.name?.toString()), [
    "Yes",
    "No",
  ]);
});

test("emoji reactions collection returns Like, EmojiReact, and custom emoji items", async () => {
  await withRollback(async (tx) => {
    const author = await insertAccountWithActor(tx, {
      username: "emojicollectionauthor",
      name: "Emoji Collection Author",
      email: "emojicollectionauthor@example.com",
    });
    const reactor = await insertRemoteActor(tx, {
      username: "emojicollectionreactor",
      name: "Emoji Collection Reactor",
      host: "remote.example",
    });
    const hiddenArticleAuthor = await insertAccountWithActor(tx, {
      username: "hiddenarticleauthor",
      name: "Hidden Article Author",
      email: "hiddenarticleauthor@example.com",
    });
    const { noteSourceId, post } = await insertNotePost(tx, {
      account: author.account,
      content: "Collect reactions",
    });
    const customEmojiId = generateUuidV7();
    const customReactionId = generateUuidV7();
    const privateCustomReactionId = generateUuidV7();
    const hiddenArticleSourceId = generateUuidV7();
    const hiddenArticlePostId = generateUuidV7();
    const hiddenArticleReactionId = generateUuidV7();
    const { post: privatePost } = await insertNotePost(tx, {
      account: author.account,
      visibility: "followers",
      content: "Private custom reaction",
    });
    await tx.insert(articleSourceTable).values({
      id: hiddenArticleSourceId,
      accountId: hiddenArticleAuthor.account.id,
      publishedYear: 2026,
      slug: "hidden-article-custom-reaction",
      quotePolicy: "everyone",
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
    });
    await tx.insert(postTable).values({
      id: hiddenArticlePostId,
      iri: `http://localhost/objects/${hiddenArticlePostId}`,
      type: "Article",
      visibility: "public",
      quotePolicy: "everyone",
      actorId: hiddenArticleAuthor.actor.id,
      articleSourceId: hiddenArticleSourceId,
      name: "Hidden article custom reaction",
      contentHtml: "<p>Hidden article custom reaction</p>",
      language: "en",
      published: new Date("2026-04-15T00:00:00.000Z"),
      updated: new Date("2026-04-15T00:00:00.000Z"),
    });
    await tx.insert(customEmojiTable).values({
      id: customEmojiId,
      iri: `http://localhost/emojis/${customEmojiId}`,
      name: ":party:",
      imageType: "image/png",
      imageUrl: `https://cdn.example/emojis/${customEmojiId}.png`,
    });
    await tx.insert(reactionTable).values([
      {
        iri: `https://remote.example/reactions/${generateUuidV7()}`,
        postId: post.id,
        actorId: reactor.id,
        emoji: "❤️",
        created: new Date("2026-04-15T00:00:03.000Z"),
      },
      {
        iri: `https://remote.example/reactions/${generateUuidV7()}`,
        postId: post.id,
        actorId: reactor.id,
        emoji: "🎉",
        created: new Date("2026-04-15T00:00:02.000Z"),
      },
      {
        iri: `http://localhost/ap/emojireacts/custom/${customReactionId}`,
        postId: post.id,
        actorId: reactor.id,
        customEmojiId,
        created: new Date("2026-04-15T00:00:01.000Z"),
      },
      {
        iri:
          `http://localhost/ap/emojireacts/custom/${privateCustomReactionId}`,
        postId: privatePost.id,
        actorId: reactor.id,
        customEmojiId,
        created: new Date("2026-04-15T00:00:00.000Z"),
      },
      {
        iri:
          `http://localhost/ap/emojireacts/custom/${hiddenArticleReactionId}`,
        postId: hiddenArticlePostId,
        actorId: reactor.id,
        customEmojiId,
        created: new Date("2026-04-14T23:59:59.000Z"),
      },
    ]);
    await tx.update(actorTable)
      .set({ suspended: new Date("2026-04-15T00:00:00.000Z") })
      .where(eq(actorTable.id, hiddenArticleAuthor.actor.id));
    const federation = await builder.build({
      kv: new MemoryKvStore(),
      origin: "http://localhost/",
    });
    const contextData = {
      db: tx,
      kv: createTestKv().kv,
      disk: createTestDisk(),
      models: {} as ContextData["models"],
      services,
    };

    const rootResponse = await federation.fetch(
      new Request(
        `http://localhost/ap/emoji-reactions/notes/${noteSourceId}`,
        { headers: { Accept: "application/activity+json" } },
      ),
      { contextData },
    );
    assert.equal(rootResponse.status, 200);
    const root = await rootResponse.json() as {
      totalItems?: number;
      first?: string | { id?: string; "@id"?: string };
    };
    assert.equal(root.totalItems, 3);
    const first = typeof root.first === "string"
      ? root.first
      : root.first?.id ?? root.first?.["@id"];
    assert.ok(first != null);

    const pageResponse = await federation.fetch(
      new Request(first, { headers: { Accept: "application/activity+json" } }),
      { contextData },
    );
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.json() as {
      items?: Record<string, unknown>[];
      orderedItems?: Record<string, unknown>[];
    };
    const items = page.items ?? page.orderedItems ?? [];
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((item) => item.type), [
      "Like",
      "EmojiReact",
      "EmojiReact",
    ]);
    assert.deepEqual(items.map((item) => item.content), [
      "❤️",
      "🎉",
      ":party:",
    ]);
    const customItem = items[2] as {
      tag?:
        | { type?: string; name?: string; icon?: { url?: string } }
        | { type?: string; name?: string; icon?: { url?: string } }[];
    };
    const customTag = Array.isArray(customItem.tag)
      ? customItem.tag[0]
      : customItem.tag;
    assert.equal(customTag?.type, "Emoji");
    assert.equal(customTag?.name, ":party:");
    assert.equal(
      customTag?.icon?.url,
      `https://cdn.example/emojis/${customEmojiId}.png`,
    );

    const customResponse = await federation.fetch(
      new Request(
        `http://localhost/ap/emojireacts/custom/${customReactionId}`,
        { headers: { Accept: "application/activity+json" } },
      ),
      { contextData },
    );
    assert.equal(customResponse.status, 200);
    const custom = await customResponse.json() as {
      id?: string;
      type?: string;
      content?: string;
      actor?: string;
      tag?:
        | { type?: string; name?: string; icon?: { url?: string } }
        | { type?: string; name?: string; icon?: { url?: string } }[];
    };
    assert.equal(
      custom.id,
      `http://localhost/ap/emojireacts/custom/${customReactionId}`,
    );
    assert.equal(custom.type, "EmojiReact");
    assert.equal(custom.content, ":party:");
    assert.equal(custom.actor, reactor.iri);
    const dereferencedTag = Array.isArray(custom.tag)
      ? custom.tag[0]
      : custom.tag;
    assert.equal(dereferencedTag?.type, "Emoji");
    assert.equal(dereferencedTag?.name, ":party:");

    const privateCustomResponse = await federation.fetch(
      new Request(
        `http://localhost/ap/emojireacts/custom/${privateCustomReactionId}`,
        { headers: { Accept: "application/activity+json" } },
      ),
      { contextData },
    );
    assert.equal(privateCustomResponse.status, 404);

    const hiddenArticleCustomResponse = await federation.fetch(
      new Request(
        `http://localhost/ap/emojireacts/custom/${hiddenArticleReactionId}`,
        { headers: { Accept: "application/activity+json" } },
      ),
      { contextData },
    );
    assert.equal(hiddenArticleCustomResponse.status, 404);
  });
});
