import type { QuotePolicy as Policy } from "@hackerspub/models/schema";
import type { QuoteTargetState as TargetState } from "@hackerspub/models/schema";
import { assertNever } from "@std/assert/unstable-never";
import { builder } from "./builder.ts";

export const QuotePolicy = builder.enumType("QuotePolicy", {
  values: [
    "EVERYONE",
    "FOLLOWERS",
    "SELF",
  ] as const,
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
  values: [
    "PENDING",
    "DENIED",
  ] as const,
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
