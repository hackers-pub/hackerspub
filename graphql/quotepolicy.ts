import type { QuotePolicy as Policy } from "@hackerspub/models/schema";
import type { QuoteTargetState as TargetState } from "@hackerspub/models/schema";
import { assertNever } from "@std/assert/unstable-never";
import { builder } from "./builder.ts";

export const QuotePolicy = builder.enumType("QuotePolicy", {
  description:
    "Controls who may embed this post as a quote in their own posts. " +
    "Applies to both local and federated clients; cross-instance requests " +
    "from restricted actors result in a QuoteTargetState on the quoting post.",
  values: {
    EVERYONE: {
      description: "Anyone — followers and non-followers alike — may quote.",
    },
    FOLLOWERS: {
      description: "Only the post author's approved followers may quote. " +
        "Non-followers' quote attempts are denied.",
    },
    SELF: {
      description:
        "Only the post author may quote their own post. Effectively " +
        "disables quoting by others.",
    },
  } as const,
});

export function toQuotePolicy(
  policy: Policy,
): typeof QuotePolicy.$inferType {
  return policy === "everyone"
    ? "EVERYONE"
    : policy === "followers"
    ? "FOLLOWERS"
    : policy === "self"
    ? "SELF"
    : assertNever(policy, `Invalid \`QuotePolicy\`: "${policy}"`);
}

export function fromQuotePolicy(
  policy: typeof QuotePolicy.$inferType,
): Policy {
  return policy === "EVERYONE"
    ? "everyone"
    : policy === "FOLLOWERS"
    ? "followers"
    : policy === "SELF"
    ? "self"
    : assertNever(policy, `Invalid \`QuotePolicy\`: "${policy}"`);
}

export const QuoteTargetState = builder.enumType("QuoteTargetState", {
  description:
    "The cross-instance quote-request approval status for this post when it " +
    "is itself the quoting post. Only non-null while the request is outstanding " +
    "or has been rejected; once approved, this field returns null.",
  values: {
    PENDING: {
      description:
        "A cross-instance quote request has been sent to the quoted post's " +
        "author and is awaiting their approval.",
    },
    DENIED: {
      description:
        "The quoted post's author rejected the quote request. The quote " +
        "should not be displayed to viewers.",
    },
  } as const,
});

export function toQuoteTargetState(
  state: TargetState | null,
): typeof QuoteTargetState.$inferType | null {
  return state == null
    ? null
    : state === "pending"
    ? "PENDING"
    : state === "denied"
    ? "DENIED"
    : assertNever(state, `Invalid \`QuoteTargetState\`: "${state}"`);
}
