import { assertEquals } from "@std/assert/equals";
import { encodeGlobalID } from "@pothos/plugin-relay";
import { execute, parse } from "graphql";
import { MockLanguageModelV3 } from "ai/test";
import { mediumTable } from "@hackerspub/models/schema";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import { schema } from "./mod.ts";
import {
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

Deno.test({
  name: "Medium.generatedAltText returns errors for guests",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(
        result.errors != null,
        true,
        "should return errors for guest",
      );
    });
  },
});

Deno.test({
  name:
    "Medium.generatedAltText returns generated text for authenticated users",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(result.errors, undefined);
      const node = (result.data as { node: { generatedAltText: string } }).node;
      assertEquals(
        node.generatedAltText,
        "A cheerful cat sitting on a keyboard.",
      );
    });
  },
});

Deno.test({
  name: "Medium.generatedAltText passes context to the AI model",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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

      assertEquals(
        capturedTextPart?.includes("My trip to the mountains"),
        true,
        "context should be passed to the AI model",
      );
    });
  },
});
