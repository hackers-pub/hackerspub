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

/**
 * A reaction the viewer wants to toggle: either a unicode `emoji` (the
 * emoji itself is the id) or a `customEmoji` (the custom emoji record id).
 */
export interface ReactionTarget {
  readonly kind: "emoji" | "customEmoji";
  readonly id: string;
}

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
  /** `true` while a toggle round-trip is in flight; further toggles no-op. */
  readonly submitting: () => boolean;
  readonly pendingReaction: () => PendingReaction | null;
  /** Localized progress text for a live region, or `null` when idle. */
  readonly pendingStatus: () => string | null;
  readonly isPendingTarget: (
    kind: ReactionTarget["kind"],
    id: string,
  ) => boolean;
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
  target: ReactionTarget,
): number {
  return groups.findIndex((group) =>
    target.kind === "emoji"
      ? group?.getValue("emoji") === target.id
      : group?.getLinkedRecord("customEmoji")?.getDataID() === target.id,
  );
}

function applyRemove(
  store: RecordSourceSelectorProxy,
  postId: string,
  target: ReactionTarget,
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
  const index = findGroupIndex(reactionGroups, target);
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
  target: ReactionTarget,
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
  const index = findGroupIndex(reactionGroups, target);
  if (index >= 0) {
    const group = reactionGroups[index];
    if (!group) return;
    let reactors = group.getLinkedRecord("reactors");
    if (!reactors) {
      reactors = store.create(
        `${postId}_reaction_${target.id}_reactors`,
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
  } else if (target.kind === "emoji") {
    // Custom emoji reactions are only ever toggled from a group that
    // already exists (the UI offers no picker for absent custom emojis),
    // so only unicode emojis create a new group client-side.
    const newGroup = store.create(
      `${postId}_reaction_${target.id}`,
      "EmojiReactionGroup",
    );
    const reactors = store.create(
      `${postId}_reaction_${target.id}_reactors`,
      "ReactionGroupReactorsConnection",
    );
    newGroup.setValue(target.id, "emoji");
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
 * Shared add/remove reaction behavior for every reaction surface (the
 * quick-pick bar and the full emoji popover): decides add vs. remove from
 * the current `note` data, commits the mutation, and patches the Relay
 * store so counts and the viewer's highlight update everywhere at once.
 *
 * Only one toggle may be in flight at a time; calls made while
 * `submitting()` is `true` are ignored, so surfaces sharing one instance
 * cannot double-submit.
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
  const isPendingTarget = (kind: ReactionTarget["kind"], id: string) => {
    const pending = pendingReaction();
    return pending?.kind === kind && pending.id === id;
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
            applyRemove(store, postId, target, actingAccountId);
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
            applyAdd(store, postId, target, actingAccountId);
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
    submitting,
    pendingReaction,
    pendingStatus,
    isPendingTarget,
  };
}
