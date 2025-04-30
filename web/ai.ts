import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

export const translator = anthropic("claude-3-7-sonnet-20250219");
export const summarizer = google("gemini-2.0-flash");
