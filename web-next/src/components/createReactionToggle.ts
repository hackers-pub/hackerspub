import { graphql } from "relay-runtime";
import { createSignal } from "solid-js";
import { createMutation } from "solid-relay";
import { showToast } from "~/components/ui/toast.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { createReactionToggleAddMutation } from "./__generated__/createReactionToggleAddMutation.graphql.ts";
import type { createReactionToggleRemoveMutation } from "./__generated__/createReactionToggleRemoveMutation.graphql.ts";
import {
  type ReactionMutationAction,
  reactionMutationSucceeded,
} from "./reactionMutationResult.ts";
import {
  type ReactionTarget,
  updateReactionStore,
} from "./reactionStoreUpdater.ts";

export type { ReactionTarget } from "./reactionStoreUpdater.ts";

export interface PendingReaction extends ReactionTarget {
  readonly action: ReactionMutationAction;
}

/**
 * The post data the toggle needs: the Relay record id plus the current
 * reaction groups, used to decide whether a toggle adds or removes.
 */
export interface ReactionToggleNote {
  readonly id: string;
  readonly reactionGroups: ReadonlyArray<{
    readonly emoji?: string | null;
    readonly customEmoji?: { readonly id: string } | null;
    readonly reactors?: {
      readonly totalCount: number;
      readonly viewerHasReacted: boolean;
    } | null;
  }>;
}

export interface ReactionToggle {
  /** Adds or removes the viewer's unicode emoji reaction. */
  readonly toggleEmoji: (emoji: string) => void;
  /** Adds or removes the viewer's custom emoji reaction. */
  readonly toggleCustomEmoji: (customEmojiId: string) => void;
  readonly pendingReaction: () => PendingReaction | null;
  /** Localized progress text for a live region, or `null` when idle. */
  readonly pendingStatus: () => string | null;
}

const addReactionToPostMutation = graphql`
  mutation createReactionToggleAddMutation($input: AddReactionToPostInput!) {
    addReactionToPost(input: $input) {
      __typename
      ... on AddReactionToPostPayload {
        reaction {
          id
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

const removeReactionFromPostMutation = graphql`
  mutation createReactionToggleRemoveMutation(
    $input: RemoveReactionFromPostInput!
  ) {
    removeReactionFromPost(input: $input) {
      __typename
      ... on RemoveReactionFromPostPayload {
        success
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

/**
 * Add/remove behavior shared by the unicode and custom quick-pick views.
 * It decides add vs. remove from the current `note` data, commits the
 * mutation, and patches the Relay store for concrete success payloads.
 *
 * Only one toggle may be in flight at a time; further clicks are ignored
 * until the current mutation settles.
 */
export function createReactionToggle(
  note: () => ReactionToggleNote | null | undefined,
): ReactionToggle {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const [pendingReaction, setPendingReaction] =
    createSignal<PendingReaction | null>(null);

  const [commitAddReaction, addingReaction] =
    createMutation<createReactionToggleAddMutation>(addReactionToPostMutation);
  const [commitRemoveReaction, removingReaction] =
    createMutation<createReactionToggleRemoveMutation>(
      removeReactionFromPostMutation,
    );

  const submitting = () =>
    addingReaction() || removingReaction() || pendingReaction() != null;
  const pendingStatus = () => {
    const pending = pendingReaction();
    if (pending == null) return null;
    return pending.action === "remove"
      ? t`Removing reaction…`
      : t`Adding reaction…`;
  };
  const showFailureToast = (action: PendingReaction["action"]) => {
    showToast({
      title: t`Failed to react`,
      description:
        action === "remove"
          ? t`Unable to remove reaction. Please try again.`
          : t`Unable to add reaction. Please try again.`,
      variant: "error",
    });
  };

  const toggle = (target: ReactionTarget) => {
    if (submitting()) return;
    const noteData = note();
    if (noteData == null) return;

    const postId = noteData.id;
    const actingAccountId = actingAccount.selectedActingAccountId();
    const existingGroup = noteData.reactionGroups.find((group) =>
      target.kind === "emoji"
        ? group.emoji === target.id
        : group.customEmoji?.id === target.id,
    );
    const action: PendingReaction["action"] = existingGroup?.reactors
      ?.viewerHasReacted
      ? "remove"
      : "add";
    setPendingReaction({ ...target, action });

    const input = {
      postId,
      ...(target.kind === "emoji"
        ? { emoji: target.id }
        : { customEmojiId: target.id }),
      ...(actingAccountId == null ? {} : { actingAccountId }),
    };
    const clearPending = () => {
      const pending = pendingReaction();
      if (pending?.kind === target.kind && pending.id === target.id) {
        setPendingReaction(null);
      }
    };

    if (action === "remove") {
      commitRemoveReaction({
        variables: { input },
        updater: (store, result) => {
          if (
            reactionMutationSucceeded("remove", result?.removeReactionFromPost)
          ) {
            updateReactionStore(store, {
              action: "remove",
              postId,
              target,
              actingAccountId,
            });
          }
        },
        onCompleted: (result) => {
          clearPending();
          if (
            !reactionMutationSucceeded("remove", result.removeReactionFromPost)
          ) {
            showFailureToast("remove");
          }
        },
        onError: (error) => {
          clearPending();
          console.error("Failed to undo reaction:", error);
          showFailureToast("remove");
        },
      });
    } else {
      commitAddReaction({
        variables: { input },
        updater: (store, result) => {
          if (reactionMutationSucceeded("add", result?.addReactionToPost)) {
            updateReactionStore(store, {
              action: "add",
              postId,
              target,
              actingAccountId,
            });
          }
        },
        onCompleted: (result) => {
          clearPending();
          if (!reactionMutationSucceeded("add", result.addReactionToPost)) {
            showFailureToast("add");
          }
        },
        onError: (error) => {
          clearPending();
          console.error("Failed to add reaction:", error);
          showFailureToast("add");
        },
      });
    }
  };

  return {
    toggleEmoji: (emoji) => toggle({ kind: "emoji", id: emoji }),
    toggleCustomEmoji: (customEmojiId) =>
      toggle({ kind: "customEmoji", id: customEmojiId }),
    pendingReaction,
    pendingStatus,
  };
}
