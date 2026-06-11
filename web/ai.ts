import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

// TODO: make model IDs configurable via env vars so they can be swapped
// when preview models are promoted or deprecated.
export const altTextGenerator = google("gemini-3.1-flash-lite-preview");
export const summarizer = google("gemini-3-flash-preview");
export const translator = anthropic("claude-sonnet-4-6");
export const moderationAnalyzer = anthropic("claude-sonnet-4-6");
