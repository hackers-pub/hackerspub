import assert from "node:assert";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { analyzeFlaggedContent } from "./moderation.ts";

const PROVISIONS = [
  {
    id: "2.3",
    section: "Community Guidelines",
    title: "Combating Discrimination and Hate Speech",
    text: "We do not tolerate hate speech.",
  },
  {
    id: "3.2",
    section: "Content Standards",
    title: "Prohibited Content",
    text: "Spam and scams are prohibited.",
  },
];

function mockModel(
  payload: unknown,
  onPrompt?: (prompt: string, system: string | undefined) => void,
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const userMessage = options.prompt.find((m) => m.role === "user");
      const textPart = userMessage?.content[0];
      const systemMessage = options.prompt.find((m) => m.role === "system");
      onPrompt?.(
        textPart?.type === "text" ? textPart.text : "",
        typeof systemMessage?.content === "string"
          ? systemMessage.content
          : undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        finishReason: { unified: "stop" as const, raw: undefined },
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
}

test("analyzeFlaggedContent() returns sanitized matches", async () => {
  let prompt = "";
  let system: string | undefined;
  const model = mockModel({
    matches: [
      {
        provision: "2.3",
        confidence: 0.9,
        rationale: "Targets a protected group.",
      },
      // Unknown provision ids are dropped:
      { provision: "9.9", confidence: 0.8, rationale: "Made up." },
      // Out-of-range confidences are clamped:
      { provision: "3.2", confidence: 7, rationale: "Looks like spam." },
    ],
    summary: "A report about hateful language in a post.",
  }, (p, s) => {
    prompt = p;
    system = s;
  });
  const analysis = await analyzeFlaggedContent({
    model,
    provisions: PROVISIONS,
    reason: "This post attacks people for their nationality.",
    contentHtml: "<p>Offensive content here.</p>",
  });
  assert.equal(analysis.matches.length, 2);
  assert.deepEqual(analysis.matches[0], {
    provision: "2.3",
    confidence: 0.9,
    rationale: "Targets a protected group.",
  });
  assert.equal(analysis.matches[1].provision, "3.2");
  assert.equal(analysis.matches[1].confidence, 1);
  assert.equal(
    analysis.summary,
    "A report about hateful language in a post.",
  );
  // The model sees the provisions, the reason, and the content:
  assert.match(prompt, /2\.3/);
  assert.match(prompt, /attacks people for their nationality/);
  assert.match(prompt, /Offensive content here/);
  // The system prompt warns about untrusted input and forbids verdicts:
  assert.ok(system != null);
  assert.match(system, /UNTRUSTED INPUT/);
  assert.match(system, /never recommend an action/);
});

test("analyzeFlaggedContent() truncates oversized untrusted input", async () => {
  let prompt = "";
  const model = mockModel(
    {
      matches: [
        { provision: "2.3", confidence: 0.5, rationale: "r" },
        // Duplicate provisions are deduplicated:
        { provision: "2.3", confidence: 0.6, rationale: "again" },
      ],
      summary: "s",
    },
    (p) => {
      prompt = p;
    },
  );
  const analysis = await analyzeFlaggedContent({
    model,
    provisions: PROVISIONS,
    reason: "r".repeat(100_000),
    contentHtml: "c".repeat(500_000),
  });
  assert.ok(prompt.length < 50_000);
  assert.match(prompt, /truncated for analysis/);
  assert.equal(analysis.matches.length, 1);
  assert.equal(analysis.matches[0].confidence, 0.5);
});

test("analyzeFlaggedContent() tolerates an empty match list", async () => {
  const model = mockModel({ matches: [], summary: "Nothing matches." });
  const analysis = await analyzeFlaggedContent({
    model,
    provisions: PROVISIONS,
    reason: "I just dislike this user.",
    contentHtml: "<p>A perfectly fine post.</p>",
  });
  assert.deepEqual(analysis.matches, []);
  assert.equal(analysis.summary, "Nothing matches.");
});
