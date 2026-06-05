import assert from "node:assert/strict";
import test from "node:test";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { MockLanguageModelV3 } from "ai/test";
import { mediumTable } from "@hackerspub/models/schema";
import { generateUuidV7, type Uuid } from "@hackerspub/models/uuid";
import {
  getMediumOwnerKey,
  getMediumUploadWindowKey,
} from "./medium-upload.ts";
import { schema } from "./mod.ts";
import {
  createTestKv,
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  withRollback,
} from "../test/postgres.ts";

// MockLanguageModelV3 declares support for the test disk URL pattern so
// the AI SDK does not attempt to download the image during tests.
const TEST_MEDIUM_URL_PATTERN = /^http:\/\/localhost\/media\/.+/;

function makeAltTextModel(responseText: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    supportedUrls: { "image/*": [TEST_MEDIUM_URL_PATTERN] },
    doGenerate: async () => ({
      content: [{ type: "text", text: responseText }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

const generatedAltTextQuery = parse(`
  query GeneratedAltText($id: ID!, $language: Locale!) {
    node(id: $id) {
      ... on Medium {
        generatedAltText(language: $language)
      }
    }
  }
`);

const generatedAltTextWithContextQuery = parse(`
  query GeneratedAltTextWithContext($id: ID!, $language: Locale!, $context: String) {
    node(id: $id) {
      ... on Medium {
        generatedAltText(language: $language, context: $context)
      }
    }
  }
`);

test("Medium.generatedAltText returns errors for guests", async () => {
  await withRollback(async (tx) => {
    const mediumId = generateUuidV7();
    await tx.insert(mediumTable).values({
      id: mediumId,
      key: `test/medium-${mediumId}.webp`,
      type: "image/webp",
    });

    const relayId = encodeGlobalID("Medium", mediumId);
    const ctx = makeGuestContext(tx, {
      altTextGenerator: makeAltTextModel("A test image."),
    });

    const result = await execute({
      schema,
      document: generatedAltTextQuery,
      contextValue: ctx,
      variableValues: { id: relayId, language: "en" },
    });

    assert.deepEqual(
      result.errors != null,
      true,
      "should return errors for guest",
    );
  });
});

test("Medium.generatedAltText returns generated text for authenticated users", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "alttext_auth_test",
      name: "Test User",
      email: "alttext_auth@example.com",
    });

    const mediumId = generateUuidV7();
    await tx.insert(mediumTable).values({
      id: mediumId,
      key: `test/medium-${mediumId}.webp`,
      type: "image/webp",
    });

    const relayId = encodeGlobalID("Medium", mediumId);
    const ctx = makeUserContext(tx, account, {
      altTextGenerator: makeAltTextModel(
        "A cheerful cat sitting on a keyboard.",
      ),
    });

    const result = await execute({
      schema,
      document: generatedAltTextQuery,
      contextValue: ctx,
      variableValues: { id: relayId, language: "en" },
    });

    assert.deepEqual(result.errors, undefined);
    const node = (result.data as { node: { generatedAltText: string } }).node;
    assert.deepEqual(
      node.generatedAltText,
      "A cheerful cat sitting on a keyboard.",
    );
  });
});

test("Medium.generatedAltText passes context to the AI model", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "alttext_ctx_test",
      name: "Test User",
      email: "alttext_ctx@example.com",
    });

    const mediumId = generateUuidV7();
    await tx.insert(mediumTable).values({
      id: mediumId,
      key: `test/medium-${mediumId}.webp`,
      type: "image/webp",
    });

    let capturedTextPart: string | undefined;
    const model = new MockLanguageModelV3({
      supportedUrls: { "image/*": [TEST_MEDIUM_URL_PATTERN] },
      doGenerate: async (options) => {
        const userMsg = options.prompt.find((m) => m.role === "user");
        if (userMsg?.role === "user") {
          const textPart = userMsg.content.find((p) => p.type === "text");
          if (textPart?.type === "text") capturedTextPart = textPart.text;
        }
        return {
          content: [{ type: "text", text: "A description." }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: {
              total: 10,
              noCache: 10,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    const relayId = encodeGlobalID("Medium", mediumId);
    const ctx = makeUserContext(tx, account, { altTextGenerator: model });

    await execute({
      schema,
      document: generatedAltTextWithContextQuery,
      contextValue: ctx,
      variableValues: {
        id: relayId,
        language: "en",
        context: "My trip to the mountains",
      },
    });

    assert.deepEqual(
      capturedTextPart?.includes("My trip to the mountains"),
      true,
      "context should be passed to the AI model",
    );
  });
});

// Helper: insert a medium row and return its relay ID.
async function insertTestMedium(
  tx: Parameters<typeof makeUserContext>[0],
  id: Uuid,
): Promise<string> {
  await tx.insert(mediumTable).values({
    id,
    key: `test/medium-${id}.webp`,
    type: "image/webp",
  });
  return encodeGlobalID("Medium", id);
}

test("generatedAltText: owner allowed while upload window is active", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "owner_window_ok",
      name: "Owner",
      email: "owner_window_ok@example.com",
    });
    const mediumId = generateUuidV7();
    const relayId = await insertTestMedium(tx, mediumId);

    const { kv, store } = createTestKv();
    store.set(getMediumOwnerKey(mediumId, account.id), true);
    store.set(getMediumUploadWindowKey(mediumId), true);

    const ctx = makeUserContext(tx, account, {
      kv,
      altTextGenerator: makeAltTextModel("Owner's image."),
    });
    const result = await execute({
      schema,
      document: generatedAltTextQuery,
      contextValue: ctx,
      variableValues: { id: relayId, language: "en" },
    });
    assert.deepEqual(result.errors, undefined, "owner should be allowed");
  });
});

test("generatedAltText: non-owner denied while upload window is active", async () => {
  await withRollback(async (tx) => {
    const { account: owner } = await insertAccountWithActor(tx, {
      username: "window_owner",
      name: "Owner",
      email: "window_owner@example.com",
    });
    const { account: other } = await insertAccountWithActor(tx, {
      username: "window_other",
      name: "Other",
      email: "window_other@example.com",
    });
    const mediumId = generateUuidV7();
    const relayId = await insertTestMedium(tx, mediumId);

    const { kv, store } = createTestKv();
    store.set(getMediumOwnerKey(mediumId, owner.id), true);
    store.set(getMediumUploadWindowKey(mediumId), true);

    const ctx = makeUserContext(tx, other, {
      kv,
      altTextGenerator: makeAltTextModel("Should not be called."),
    });
    const result = await execute({
      schema,
      document: generatedAltTextQuery,
      contextValue: ctx,
      variableValues: { id: relayId, language: "en" },
    });
    assert.deepEqual(
      result.errors != null,
      true,
      "non-owner should be denied during active window",
    );
  });
});

test("generatedAltText: any authenticated user allowed after window expires", async () => {
  await withRollback(async (tx) => {
    const { account } = await insertAccountWithActor(tx, {
      username: "expired_window_user",
      name: "User",
      email: "expired_window_user@example.com",
    });
    const mediumId = generateUuidV7();
    const relayId = await insertTestMedium(tx, mediumId);

    // No KV entries at all — simulates the window having expired.
    const ctx = makeUserContext(tx, account, {
      altTextGenerator: makeAltTextModel("Old image."),
    });
    const result = await execute({
      schema,
      document: generatedAltTextQuery,
      contextValue: ctx,
      variableValues: { id: relayId, language: "en" },
    });
    assert.deepEqual(
      result.errors,
      undefined,
      "any authenticated user should succeed after window expires",
    );
  });
});

test("generatedAltText: two accounts uploading identical content both get access", async () => {
  await withRollback(async (tx) => {
    const { account: accountA } = await insertAccountWithActor(tx, {
      username: "dedup_account_a",
      name: "Account A",
      email: "dedup_a@example.com",
    });
    const { account: accountB } = await insertAccountWithActor(tx, {
      username: "dedup_account_b",
      name: "Account B",
      email: "dedup_b@example.com",
    });
    // Same medium row shared by content-hash deduplication.
    const mediumId = generateUuidV7();
    const relayId = await insertTestMedium(tx, mediumId);

    const { kv, store } = createTestKv();
    store.set(getMediumOwnerKey(mediumId, accountA.id), true);
    store.set(getMediumOwnerKey(mediumId, accountB.id), true);
    store.set(getMediumUploadWindowKey(mediumId), true);

    for (const account of [accountA, accountB]) {
      const ctx = makeUserContext(tx, account, {
        kv,
        altTextGenerator: makeAltTextModel("Shared image."),
      });
      const result = await execute({
        schema,
        document: generatedAltTextQuery,
        contextValue: ctx,
        variableValues: { id: relayId, language: "en" },
      });
      assert.deepEqual(
        result.errors,
        undefined,
        `${account.username} should be allowed`,
      );
    }
  });
});
