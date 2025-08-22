import type { PostVisibility as Visibility } from "@hackerspub/models/schema";
import { assertNever } from "@std/assert/unstable-never";
import { builder } from "./builder.ts";

export const PostVisibility = builder.enumType("PostVisibility", {
  values: [
    "PUBLIC",
    "UNLISTED",
    "FOLLOWERS",
    "DIRECT",
    "NONE",
  ] as const,
});

export function toPostVisibility(
  visibility: Visibility,
): typeof PostVisibility.$inferType {
  return visibility === "public"
    ? "PUBLIC"
    : visibility === "unlisted"
    ? "UNLISTED"
    : visibility === "followers"
    ? "FOLLOWERS"
    : visibility === "direct"
    ? "DIRECT"
    : visibility === "none"
    ? "NONE"
    : assertNever(
      visibility,
      `Invalid \`PostVisibility\`: "${visibility}"`,
    );
}

export function fromPostVisibility(
  visibility: typeof PostVisibility.$inferType,
): Visibility {
  return visibility === "PUBLIC"
    ? "public"
    : visibility === "UNLISTED"
    ? "unlisted"
    : visibility === "FOLLOWERS"
    ? "followers"
    : visibility === "DIRECT"
    ? "direct"
    : visibility === "NONE"
    ? "none"
    : assertNever(
      visibility,
      `Invalid \`PostVisibility\`: "${visibility}"`,
    );
}
