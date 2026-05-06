import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

export const altTextGenerator = google("gemini-3.1-flash-lite-preview");
export const summarizer = google("gemini-3-flash-preview");
export const translator = anthropic("claude-sonnet-4-5-20250929");
