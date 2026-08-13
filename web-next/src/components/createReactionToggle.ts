import {
  graphql,
  type RecordProxy,
  type RecordSourceSelectorProxy,
} from "relay-runtime";
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

export interface PendingReaction {
  readonly emoji: string;
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
    readonly reactors?: {
      readonly viewerHasReacted: boolean;
    } | null;
  }>;
}

export interface ReactionToggle {
  /** Adds or removes the viewer's unicode emoji reaction. */
  readonly toggleEmoji: (emoji: string) => void;
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

function viewerReactionArgs(actingAccountId: string | null | undefined) {
  return actingAccountId == null ? null : { actingAccountId };
}

function findGroupIndex(
  groups: ReadonlyArray<RecordProxy | null | undefined>,
  emoji: string,
): number {
  return groups.findIndex((group) => group?.getValue("emoji") === emoji);
}

function applyRemove(
  store: RecordSourceSelectorProxy,
  postId: string,
  emoji: string,
  actingAccountId: string | null | undefined,
): void {
  const postRecord = store.get(postId);
  if (!postRecord) return;

  const engagementStats = postRecord.getLinkedRecord("engagementStats");
  if (engagementStats) {
    const current = (engagementStats.getValue("reactions") as number) || 0;
    engagementStats.setValue(Math.max(0, current - 1), "reactions");
  }

  const reactionGroups = postRecord.getLinkedRecords("reactionGroups") || [];
  const index = findGroupIndex(reactionGroups, emoji);
  if (index < 0) return;
  const group = reactionGroups[index];
  if (!group) return;

  const reactors = group.getLinkedRecord("reactors");
  const count = (reactors?.getValue("totalCount") as number) || 0;
  if (count <= 1) {
    postRecord.setLinkedRecords(
      reactionGroups.filter((_, i) => i !== index),
      "reactionGroups",
    );
    if (reactors) store.delete(reactors.getDataID());
    store.delete(group.getDataID());
  } else {
    reactors?.setValue(count - 1, "totalCount");
    reactors?.setValue(
      false,
      "viewerHasReacted",
      viewerReactionArgs(actingAccountId),
    );
  }
}

function applyAdd(
  store: RecordSourceSelectorProxy,
  postId: string,
  emoji: string,
  actingAccountId: string | null | undefined,
): void {
  const postRecord = store.get(postId);
  if (!postRecord) return;

  const engagementStats = postRecord.getLinkedRecord("engagementStats");
  if (engagementStats) {
    const current = (engagementStats.getValue("reactions") as number) || 0;
    engagementStats.setValue(current + 1, "reactions");
  }

  const reactionGroups = postRecord.getLinkedRecords("reactionGroups") || [];
  const index = findGroupIndex(reactionGroups, emoji);
  if (index >= 0) {
    const group = reactionGroups[index];
    if (!group) return;
    let reactors = group.getLinkedRecord("reactors");
    if (!reactors) {
      reactors = store.create(
        `${postId}_reaction_${emoji}_reactors`,
        "ReactionGroupReactorsConnection",
      );
      group.setLinkedRecord(reactors, "reactors");
    }
    const count = (reactors.getValue("totalCount") as number) || 0;
    reactors.setValue(count + 1, "totalCount");
    reactors.setValue(
      true,
      "viewerHasReacted",
      viewerReactionArgs(actingAccountId),
    );
  } else {
    const newGroup = store.create(
      `${postId}_reaction_${emoji}`,
      "EmojiReactionGroup",
    );
    const reactors = store.create(
      `${postId}_reaction_${emoji}_reactors`,
      "ReactionGroupReactorsConnection",
    );
    newGroup.setValue(emoji, "emoji");
    reactors.setValue(1, "totalCount");
    reactors.setValue(
      true,
      "viewerHasReacted",
      viewerReactionArgs(actingAccountId),
    );
    newGroup.setLinkedRecord(reactors, "reactors");
    newGroup.setLinkedRecord(postRecord, "subject");
    postRecord.setLinkedRecords(
      [...reactionGroups, newGroup],
      "reactionGroups",
    );
  }
}

/**
 * Add/remove behavior for the quick-pick bar: decides add vs. remove from
 * the current `note` data, commits the mutation, and patches the Relay
 * store so counts and the viewer's highlight update immediately.
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

  const toggleEmoji = (emoji: string) => {
    if (submitting()) return;
    const noteData = note();
    if (noteData == null) return;

    const postId = noteData.id;
    const actingAccountId = actingAccount.selectedActingAccountId();
    const existingGroup = noteData.reactionGroups.find(
      (group) => group.emoji === emoji,
    );
    const action: PendingReaction["action"] = existingGroup?.reactors
      ?.viewerHasReacted
      ? "remove"
      : "add";
    setPendingReaction({ emoji, action });

    const input = {
      postId,
      emoji,
      ...(actingAccountId == null ? {} : { actingAccountId }),
    };
    const clearPending = () => {
      const pending = pendingReaction();
      if (pending?.emoji === emoji) {
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
            applyRemove(store, postId, emoji, actingAccountId);
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
            applyAdd(store, postId, emoji, actingAccountId);
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
    toggleEmoji,
    pendingReaction,
    pendingStatus,
  };
}
