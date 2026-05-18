import type { PostVisibility as Visibility } from "@hackerspub/models/schema";
import { assertNever } from "@std/assert/unstable-never";
import { builder } from "./builder.ts";

export const PostVisibility = builder.enumType("PostVisibility", {
  description:
    "Controls who can see a post and whether it appears in timelines. " +
    "Visibility is set at creation time and cannot be changed for posts " +
    "that have already been federated to remote instances.",
  values: {
    PUBLIC: {
      description:
        "Visible to everyone including unauthenticated visitors. Appears " +
        "in the public timeline and the actor's public post list. Federated " +
        "to all known instances.",
    },
    UNLISTED: {
      description:
        "Accessible via direct link but excluded from the public timeline. " +
        "Use for posts that should be reachable without being broadcast widely.",
    },
    FOLLOWERS: {
      description:
        "Visible only to the actor's approved followers. Never appears in " +
        "any public timeline. Federated only to follower inboxes.",
    },
    DIRECT: {
      description:
        "Visible only to explicitly @-mentioned actors — the closest " +
        "equivalent to a direct message. Not delivered to followers who " +
        "were not mentioned.",
    },
    NONE: {
      description:
        "Not visible to anyone other than the author. Used internally for " +
        "soft-deleted or administratively hidden posts; do not set this " +
        "value when creating posts.",
    },
  } as const,
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
