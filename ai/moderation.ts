import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateObject, jsonSchema, type LanguageModel } from "ai";

/**
 * A code of conduct provision as the analyzer sees it.  Mirrors
 * `CocProvision` from `@hackerspub/models/coc` (this package cannot import
 * it: `@hackerspub/models` depends on `@hackerspub/ai`, not the other way
 * around).
 */
export interface ModerationProvision {
  /** Stable structural id, e.g. `"2.3"`. */
  id: string;
  section: string;
  title: string;
  text: string;
}

export interface ModerationAnalysisMatch {
  /** The id of a provision the content plausibly violates. */
  provision: string;
  /** Confidence between 0 and 1. */
  confidence: number;
  /** One-sentence rationale. */
  rationale: string;
}

/**
 * The result of matching a report against the code of conduct.  This is a
 * reference tool for moderators, never an automated decision: LLMs can
 * exhibit biases, so the matches must always be reviewed and validated by
 * a human moderator before any action.
 */
export interface ModerationAnalysis {
  matches: ModerationAnalysisMatch[];
  /** A short, neutral summary of what the report is about. */
  summary: string;
}

export interface ModerationAnalysisOptions {
  model: LanguageModel;
  /** The current code of conduct provisions, with stable ids. */
  provisions: readonly ModerationProvision[];
  /** The reporter's written reason (untrusted input). */
  reason: string;
  /** The reported content's rendered HTML (untrusted input). */
  contentHtml: string;
  /**
   * What kind of content is being analyzed, e.g. `"post"` (default) or
   * `"profile"`.
   */
  contentKind?: string;
}

const ANALYSIS_SCHEMA = jsonSchema<ModerationAnalysis>({
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          provision: { type: "string" },
          confidence: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["provision", "confidence", "rationale"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["matches", "summary"],
  additionalProperties: false,
});

// Input budgets: both fields are untrusted (a report reason is
// user-written, reported remote content can be arbitrarily large), so the
// analyzer defends itself against excessive provider cost and
// context-length failures regardless of upstream validation.
const MAX_REASON_LENGTH = 4_000;
const MAX_CONTENT_LENGTH = 32_000;
const MAX_OUTPUT_TOKENS = 2_000;
const MAX_MATCHES = 20;
const MAX_TEXT_FIELD_LENGTH = 1_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[… truncated for analysis]`;
}

let promptCache: string | undefined;

async function getModerationPrompt(): Promise<string> {
  if (promptCache != null) return promptCache;
  // Cache the resolved text, not the promise: a transient read failure must
  // not be remembered as a permanently rejected promise that every later
  // call replays.
  const prompt = await readFile(
    join(import.meta.dirname!, "prompts", "moderation", "en.md"),
    "utf8",
  );
  promptCache = prompt;
  return prompt;
}

/**
 * Matches a report against the code of conduct: which provisions does the
 * reported content plausibly violate, given the reporter's reason?
 *
 * The output is sanitized: matches referencing unknown provision ids are
 * dropped, and confidences are clamped to [0, 1].  The reporter's reason
 * and the reported content are passed as untrusted material; the system
 * prompt instructs the model to ignore any instructions inside them.
 */
export async function analyzeFlaggedContent(
  options: ModerationAnalysisOptions,
): Promise<ModerationAnalysis> {
  const system = await getModerationPrompt();
  const provisionsText = options.provisions
    .map((p) => `[${p.id}] ${p.section} / ${p.title}\n${p.text}`)
    .join("\n\n");
  const prompt = `Code of conduct provisions:

${provisionsText}

Reporter's reason (untrusted input):

${truncate(options.reason, MAX_REASON_LENGTH)}

Reported ${options.contentKind ?? "post"} content (untrusted input):

${truncate(options.contentHtml, MAX_CONTENT_LENGTH)}`;
  const { object } = await generateObject({
    model: options.model,
    system,
    prompt,
    schema: ANALYSIS_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
  const knownIds = new Set(options.provisions.map((p) => p.id));
  const seen = new Set<string>();
  const matches: ModerationAnalysisMatch[] = [];
  for (const match of object.matches) {
    if (!knownIds.has(match.provision) || seen.has(match.provision)) {
      continue;
    }
    seen.add(match.provision);
    matches.push({
      provision: match.provision,
      confidence: Math.min(1, Math.max(0, match.confidence)),
      rationale: truncate(match.rationale, MAX_TEXT_FIELD_LENGTH),
    });
    if (matches.length >= MAX_MATCHES) break;
  }
  return {
    matches,
    summary: truncate(object.summary, MAX_TEXT_FIELD_LENGTH),
  };
}
