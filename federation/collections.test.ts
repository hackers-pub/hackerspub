import assert from "node:assert";
import test from "node:test";
import type { Context } from "@fedify/fedify";
import { MemoryKvStore } from "@fedify/fedify";
import { Question } from "@fedify/vocab";
import type { ContextData } from "@hackerspub/models/context";
import type { Transaction } from "@hackerspub/models/db";
import type { Uuid } from "@hackerspub/models/uuid";
import { builder } from "./builder.ts";
import { toFeaturedCollectionItem } from "./collections.ts";
import {
  createTestDisk,
  createTestKv,
  insertAccountWithActor,
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
    contentHtml: "<p>Poll question</p>",
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
  assert.equal(item.content?.toString(), "<p>Poll question</p>");
  assert.equal(item.name?.toString(), "Poll question");
  const options = await Array.fromAsync(item.getExclusiveOptions());
  assert.deepEqual(options.map((option) => option.name?.toString()), [
    "Yes",
    "No",
  ]);
});
