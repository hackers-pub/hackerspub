import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";

export const summarizer = google("gemini-3.0-flash");
export const translator = anthropic("claude-sonnet-4-5-20241022");
