export type ReactionMutationAction = "add" | "remove";

export interface ReactionMutationPayload {
  readonly __typename?: string;
  readonly reaction?: unknown;
  readonly success?: boolean;
}

/**
 * Returns whether a reaction mutation payload represents the successful
 * branch.  Relay runs mutation updaters for error union members too, so the
 * caller must check the payload before changing cached reaction counts.
 */
export function reactionMutationSucceeded(
  action: ReactionMutationAction,
  payload: ReactionMutationPayload | null | undefined,
): boolean {
  return action === "add"
    ? payload?.__typename === "AddReactionToPostPayload" &&
        payload.reaction != null
    : payload?.__typename === "RemoveReactionFromPostPayload" &&
        payload.success === true;
}
