import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { generateAltText } from "./alttext.ts";

// A 1×1 transparent GIF as a data URL — avoids network downloads in tests.
const DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

test("generateAltText() returns trimmed text from the model response", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "  A cat sitting on a keyboard.  \n" }],
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

  const result = await generateAltText({
    model,
    imageUrl: DATA_URL,
    language: "en",
  });

  assert.equal(result, "A cat sitting on a keyboard.");
});

test("generateAltText() sends an image file part to the model", async () => {
  let hasImageFilePart = false;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      for (const message of options.prompt) {
        if (message.role !== "user") continue;
        for (const part of message.content) {
          if (
            part.type === "file" &&
            typeof part.mediaType === "string" &&
            part.mediaType.startsWith("image/")
          ) {
            hasImageFilePart = true;
          }
        }
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

  await generateAltText({ model, imageUrl: DATA_URL, language: "en" });

  assert.ok(hasImageFilePart, "model should receive an image file part");
});

test("generateAltText() sends a system prompt to the model", async () => {
  let capturedSystem: string | undefined;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const sysMsg = options.prompt.find((m) => m.role === "system");
      if (sysMsg?.role === "system") capturedSystem = sysMsg.content;
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

  await generateAltText({ model, imageUrl: DATA_URL, language: "en" });

  assert.ok(capturedSystem != null, "model should receive a system prompt");
  assert.ok(capturedSystem.length > 0, "system prompt should not be empty");
});

test("generateAltText() uses a Korean system prompt for Korean language", async () => {
  let capturedSystem: string | undefined;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const sysMsg = options.prompt.find((m) => m.role === "system");
      if (sysMsg?.role === "system") capturedSystem = sysMsg.content;
      return {
        content: [{ type: "text", text: "설명입니다." }],
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

  await generateAltText({ model, imageUrl: DATA_URL, language: "ko" });

  assert.ok(capturedSystem != null, "system prompt should be set");
  assert.ok(
    capturedSystem.includes("한국어") || capturedSystem.includes("접근성"),
    "Korean prompt should contain Korean-specific text",
  );
});

test("generateAltText() falls back to English prompt for unsupported locales", async () => {
  let capturedSystem: string | undefined;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const sysMsg = options.prompt.find((m) => m.role === "system");
      if (sysMsg?.role === "system") capturedSystem = sysMsg.content;
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

  await generateAltText({ model, imageUrl: DATA_URL, language: "ar" });

  assert.ok(capturedSystem != null, "system prompt should be set");
  assert.ok(
    capturedSystem.includes("accessibility") ||
      capturedSystem.includes("English"),
    "should fall back to English prompt for unsupported locales",
  );
});

test("generateAltText() includes note context in the user text when provided", async () => {
  let capturedTextPart: string | undefined;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const userMsg = options.prompt.find((m) => m.role === "user");
      if (userMsg?.role === "user") {
        const textPart = userMsg.content.find((p) => p.type === "text");
        if (textPart?.type === "text") capturedTextPart = textPart.text;
      }
      return {
        content: [{ type: "text", text: "A cat." }],
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

  await generateAltText({
    model,
    imageUrl: DATA_URL,
    language: "en",
    context: "My home office setup",
  });

  assert.ok(capturedTextPart?.includes("My home office setup"));
});

test("generateAltText() does not add context hint when context is absent", async () => {
  let capturedTextPart: string | undefined;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const userMsg = options.prompt.find((m) => m.role === "user");
      if (userMsg?.role === "user") {
        const textPart = userMsg.content.find((p) => p.type === "text");
        if (textPart?.type === "text") capturedTextPart = textPart.text;
      }
      return {
        content: [{ type: "text", text: "A photo." }],
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

  await generateAltText({ model, imageUrl: DATA_URL, language: "en" });

  assert.ok(capturedTextPart != null);
  assert.ok(
    !capturedTextPart.toLowerCase().includes("context:"),
    "no context hint should appear when context is absent",
  );
});
