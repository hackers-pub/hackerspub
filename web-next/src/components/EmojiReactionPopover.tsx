import { REACTION_EMOJIS, sortReactionGroups } from "@hackerspub/models/emoji";
import { graphql } from "relay-runtime";
import { createSignal, For, Show } from "solid-js";
import { createMutation } from "solid-relay";
import IconLoader2 from "~icons/lucide/loader-2";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { EmojiReactionPopoverAddMutation } from "./__generated__/EmojiReactionPopoverAddMutation.graphql.ts";
import type { EmojiReactionPopoverRemoveMutation } from "./__generated__/EmojiReactionPopoverRemoveMutation.graphql.ts";

interface NoteData {
  id: string;
  reactionGroups: ReadonlyArray<{
    readonly __typename?: string;
    readonly emoji?: string;
    readonly customEmoji?: {
      readonly id: string;
      readonly name: string;
      readonly imageUrl: string;
    } | undefined;
    readonly reactors?: {
      readonly totalCount: number;
      readonly viewerHasReacted: boolean;
    };
  }>;
}

export interface EmojiReactionPopoverProps {
  noteData: NoteData;
  onClose: () => void;
}

interface PendingReaction {
  kind: "emoji" | "customEmoji";
  id: string;
  action: "add" | "remove";
}

function viewerReactionArgs(actingAccountId: string | null | undefined) {
  return actingAccountId == null ? null : { actingAccountId };
}

const addReactionToPostMutation = graphql`
  mutation EmojiReactionPopoverAddMutation($input: AddReactionToPostInput!) {
    addReactionToPost(input: $input) {
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
  mutation EmojiReactionPopoverRemoveMutation($input: RemoveReactionFromPostInput!) {
    removeReactionFromPost(input: $input) {
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

export function EmojiReactionPopover(props: EmojiReactionPopoverProps) {
  const { t } = useLingui();
  const actingAccount = useActingAccount();
  const [pendingReaction, setPendingReaction] = createSignal<
    PendingReaction | null
  >(null);

  const [commitAddReaction, addingReaction] = createMutation<
    EmojiReactionPopoverAddMutation
  >(addReactionToPostMutation);

  const [commitRemoveReaction, removingReaction] = createMutation<
    EmojiReactionPopoverRemoveMutation
  >(removeReactionFromPostMutation);

  const isSubmitting = () =>
    addingReaction() || removingReaction() ||
    pendingReaction() != null;
  const pendingStatus = () => {
    const pending = pendingReaction();
    if (pending == null) return null;
    return pending.action === "remove"
      ? t`Removing reaction…`
      : t`Adding reaction…`;
  };
  const isPendingTarget = (
    kind: PendingReaction["kind"],
    id: string,
  ) => {
    const pending = pendingReaction();
    return pending?.kind === kind && pending.id === id;
  };
  const clearPendingReaction = (
    kind: PendingReaction["kind"],
    id: string,
  ) => {
    const pending = pendingReaction();
    if (pending?.kind === kind && pending.id === id) {
      setPendingReaction(null);
    }
  };

  const handleEmojiClick = (emoji: string) => {
    if (isSubmitting()) return;

    const noteData = props.noteData;
    const postId = noteData.id;
    const actingAccountId = actingAccount.selectedActingAccountId();
    // Check if user has already reacted with this emoji
    const existingReaction = noteData.reactionGroups.find((group) => {
      if (group.emoji) {
        return group.emoji === emoji;
      }
      return false;
    });

    // Toggle: if user has reacted, undo; if not, add
    const shouldUndo = existingReaction?.reactors?.viewerHasReacted;
    setPendingReaction({
      kind: "emoji",
      id: emoji,
      action: shouldUndo ? "remove" : "add",
    });

    if (shouldUndo) {
      commitRemoveReaction({
        variables: {
          input: {
            postId,
            emoji,
            ...(actingAccountId == null ? {} : { actingAccountId }),
          },
        },
        updater: (store) => {
          // Handle undo reaction
          const postRecord = store.get(postId);
          if (postRecord) {
            // Update engagement stats
            const engagementStats = postRecord.getLinkedRecord(
              "engagementStats",
            );
            if (engagementStats) {
              const currentReactions =
                engagementStats.getValue("reactions") as number || 0;
              const newReactionCount = Math.max(0, currentReactions - 1);
              engagementStats.setValue(newReactionCount, "reactions");
            }

            // Update reaction groups
            const reactionGroups =
              postRecord.getLinkedRecords("reactionGroups") || [];
            const existingGroupIndex = reactionGroups.findIndex((group) => {
              const groupEmoji = group?.getValue("emoji");
              return groupEmoji === emoji;
            });

            if (existingGroupIndex >= 0) {
              const existingGroup = reactionGroups[existingGroupIndex];
              if (existingGroup) {
                const reactors = existingGroup.getLinkedRecord("reactors");
                const currentCount =
                  reactors?.getValue("totalCount") as number || 0;
                if (currentCount <= 1) {
                  // Remove the group entirely
                  const updatedGroups = reactionGroups.filter((_, index) =>
                    index !== existingGroupIndex
                  );
                  postRecord.setLinkedRecords(
                    updatedGroups,
                    "reactionGroups",
                  );
                  if (reactors) store.delete(reactors.getDataID());
                  // Also delete the group record from the store
                  store.delete(existingGroup.getDataID());
                } else {
                  // Decrement count and mark as not reacted
                  reactors?.setValue(currentCount - 1, "totalCount");
                  reactors?.setValue(
                    false,
                    "viewerHasReacted",
                    viewerReactionArgs(actingAccountId),
                  );
                }
              }
            }
          }
        },
        onCompleted: (result) => {
          clearPendingReaction("emoji", emoji);
          // For remove mutations, check success field
          if (
            !result.removeReactionFromPost ||
            !("success" in result.removeReactionFromPost) ||
            !result.removeReactionFromPost.success
          ) {
            showToast({
              title: t`Failed to react`,
              description: t`Unable to remove reaction. Please try again.`,
              variant: "error",
            });
          }
        },
        onError: (error) => {
          clearPendingReaction("emoji", emoji);
          console.error("Failed to undo reaction:", error);
          showToast({
            title: t`Failed to react`,
            description: t`Unable to remove reaction. Please try again.`,
            variant: "error",
          });
        },
      });
    } else {
      commitAddReaction({
        variables: {
          input: {
            postId,
            emoji,
            ...(actingAccountId == null ? {} : { actingAccountId }),
          },
        },
        updater: (store) => {
          // Handle add reaction
          const postRecord = store.get(postId);
          if (postRecord) {
            // Update engagement stats
            const engagementStats = postRecord.getLinkedRecord(
              "engagementStats",
            );
            if (engagementStats) {
              const currentReactions =
                engagementStats.getValue("reactions") as number || 0;
              engagementStats.setValue(currentReactions + 1, "reactions");
            }

            // Update reaction groups
            const reactionGroups =
              postRecord.getLinkedRecords("reactionGroups") || [];
            const existingGroupIndex = reactionGroups.findIndex((group) => {
              const groupEmoji = group?.getValue("emoji");
              return groupEmoji === emoji;
            });

            if (existingGroupIndex >= 0) {
              // Increment count for existing group and mark as reacted
              const existingGroup = reactionGroups[existingGroupIndex];
              if (existingGroup) {
                let reactors = existingGroup.getLinkedRecord("reactors");
                if (!reactors) {
                  reactors = store.create(
                    `${postId}_reaction_${emoji}_reactors`,
                    "ReactionGroupReactorsConnection",
                  );
                  existingGroup.setLinkedRecord(reactors, "reactors");
                }
                const currentCount =
                  reactors.getValue("totalCount") as number || 0;
                reactors.setValue(currentCount + 1, "totalCount");
                reactors.setValue(
                  true,
                  "viewerHasReacted",
                  viewerReactionArgs(actingAccountId),
                );
              }
            } else {
              // Create new reaction group
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

              const updatedGroups = [...reactionGroups, newGroup];
              postRecord.setLinkedRecords(updatedGroups, "reactionGroups");
            }
          }
        },
        onCompleted: (result) => {
          clearPendingReaction("emoji", emoji);
          // For add mutations, check reaction field
          if (
            !result.addReactionToPost ||
            !("reaction" in result.addReactionToPost) ||
            !result.addReactionToPost.reaction
          ) {
            showToast({
              title: t`Failed to react`,
              description: t`Unable to add reaction. Please try again.`,
              variant: "error",
            });
          }
        },
        onError: (error) => {
          clearPendingReaction("emoji", emoji);
          console.error("Failed to add reaction:", error);
          showToast({
            title: t`Failed to react`,
            description: t`Unable to add reaction. Please try again.`,
            variant: "error",
          });
        },
      });
    }
  };

  const handleCustomEmojiClick = (customEmojiId: string) => {
    if (isSubmitting()) return;

    const noteData = props.noteData;
    const postId = noteData.id;
    const actingAccountId = actingAccount.selectedActingAccountId();
    const existingReaction = noteData.reactionGroups.find((group) =>
      group.customEmoji?.id === customEmojiId
    );
    const shouldUndo = existingReaction?.reactors?.viewerHasReacted;
    setPendingReaction({
      kind: "customEmoji",
      id: customEmojiId,
      action: shouldUndo ? "remove" : "add",
    });

    if (shouldUndo) {
      commitRemoveReaction({
        variables: {
          input: {
            postId,
            customEmojiId,
            ...(actingAccountId == null ? {} : { actingAccountId }),
          },
        },
        updater: (store) => {
          const postRecord = store.get(postId);
          if (postRecord) {
            const engagementStats = postRecord.getLinkedRecord(
              "engagementStats",
            );
            if (engagementStats) {
              const current = engagementStats.getValue("reactions") as number ||
                0;
              engagementStats.setValue(Math.max(0, current - 1), "reactions");
            }
            const reactionGroups =
              postRecord.getLinkedRecords("reactionGroups") || [];
            const idx = reactionGroups.findIndex((g) =>
              g?.getLinkedRecord("customEmoji")?.getDataID() === customEmojiId
            );
            if (idx >= 0) {
              const group = reactionGroups[idx];
              if (group) {
                const reactors = group.getLinkedRecord("reactors");
                const count = reactors?.getValue("totalCount") as number || 0;
                if (count <= 1) {
                  postRecord.setLinkedRecords(
                    reactionGroups.filter((_, i) => i !== idx),
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
            }
          }
        },
        onCompleted: (result) => {
          clearPendingReaction("customEmoji", customEmojiId);
          if (
            !result.removeReactionFromPost ||
            !("success" in result.removeReactionFromPost) ||
            !result.removeReactionFromPost.success
          ) {
            showToast({
              title: t`Failed to react`,
              description: t`Unable to remove reaction. Please try again.`,
              variant: "error",
            });
          }
        },
        onError: (error) => {
          clearPendingReaction("customEmoji", customEmojiId);
          console.error("Failed to undo custom emoji reaction:", error);
          showToast({
            title: t`Failed to react`,
            description: t`Unable to remove reaction. Please try again.`,
            variant: "error",
          });
        },
      });
    } else {
      commitAddReaction({
        variables: {
          input: {
            postId,
            customEmojiId,
            ...(actingAccountId == null ? {} : { actingAccountId }),
          },
        },
        updater: (store) => {
          const postRecord = store.get(postId);
          if (postRecord) {
            const engagementStats = postRecord.getLinkedRecord(
              "engagementStats",
            );
            if (engagementStats) {
              const current = engagementStats.getValue("reactions") as number ||
                0;
              engagementStats.setValue(current + 1, "reactions");
            }
            const reactionGroups =
              postRecord.getLinkedRecords("reactionGroups") || [];
            const idx = reactionGroups.findIndex((g) =>
              g?.getLinkedRecord("customEmoji")?.getDataID() === customEmojiId
            );
            if (idx >= 0) {
              const group = reactionGroups[idx];
              if (group) {
                let reactors = group.getLinkedRecord("reactors");
                if (!reactors) {
                  reactors = store.create(
                    `${postId}_reaction_${customEmojiId}_reactors`,
                    "ReactionGroupReactorsConnection",
                  );
                  group.setLinkedRecord(reactors, "reactors");
                }
                const count = reactors.getValue("totalCount") as number || 0;
                reactors.setValue(count + 1, "totalCount");
                reactors.setValue(
                  true,
                  "viewerHasReacted",
                  viewerReactionArgs(actingAccountId),
                );
              }
            }
          }
        },
        onCompleted: (result) => {
          clearPendingReaction("customEmoji", customEmojiId);
          if (
            !result.addReactionToPost ||
            !("reaction" in result.addReactionToPost) ||
            !result.addReactionToPost.reaction
          ) {
            showToast({
              title: t`Failed to react`,
              description: t`Unable to add reaction. Please try again.`,
              variant: "error",
            });
          }
        },
        onError: (error) => {
          clearPendingReaction("customEmoji", customEmojiId);
          console.error("Failed to add custom emoji reaction:", error);
          showToast({
            title: t`Failed to react`,
            description: t`Unable to add reaction. Please try again.`,
            variant: "error",
          });
        },
      });
    }
  };

  const sortedReactionGroups = () => {
    return sortReactionGroups(props.noteData?.reactionGroups || []);
  };

  const availableEmojis = () => {
    // Get emojis that are already used in current reactions
    const usedEmojis = new Set(
      sortedReactionGroups()
        .map((group) => group.emoji)
        .filter(Boolean),
    );

    // Filter out already used emojis from the available emojis
    return REACTION_EMOJIS.filter((emoji) => !usedEmojis.has(emoji));
  };

  return (
    <div
      class="p-4 space-y-4"
      aria-busy={isSubmitting()}
    >
      <Show when={pendingStatus()}>
        {(status) => (
          <span class="sr-only" aria-live="polite">
            {status()}
          </span>
        )}
      </Show>
      {/* Existing Reactions */}
      <Show when={sortedReactionGroups().length > 0}>
        <div class="space-y-2">
          <div class="flex flex-wrap gap-2">
            <For each={sortedReactionGroups()}>
              {(group) => {
                const target = () =>
                  group.emoji == null
                    ? group.customEmoji == null ? null : {
                      kind: "customEmoji" as const,
                      id: group.customEmoji.id,
                    }
                    : { kind: "emoji" as const, id: group.emoji };
                const pending = () => {
                  const value = target();
                  return value == null
                    ? false
                    : isPendingTarget(value.kind, value.id);
                };
                return (
                  <Button
                    variant={group.reactors?.viewerHasReacted === true
                      ? "secondary"
                      : "outline"}
                    size="sm"
                    class={group.reactors?.viewerHasReacted === true
                      ? "relative h-8 gap-2 cursor-pointer border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/60"
                      : "relative h-8 gap-2 cursor-pointer"}
                    disabled={isSubmitting()}
                    title={pending()
                      ? pendingStatus() ?? undefined
                      : group.reactors?.viewerHasReacted === true
                      ? t`Remove ${
                        group.emoji || group.customEmoji?.name || t`reaction`
                      }`
                      : t`Add ${
                        group.emoji || group.customEmoji?.name || t`reaction`
                      }`}
                    onClick={() => {
                      if (group.emoji) {
                        handleEmojiClick(group.emoji);
                      } else if (group.customEmoji) {
                        handleCustomEmojiClick(group.customEmoji.id);
                      }
                    }}
                  >
                    <span
                      class="inline-flex items-center gap-2"
                      classList={{ "opacity-30": pending() }}
                    >
                      <Show
                        when={group.emoji}
                        fallback={
                          <Show keyed when={group.customEmoji}>
                            {(customEmoji) => (
                              <img
                                src={customEmoji.imageUrl}
                                alt={customEmoji.name}
                                class="size-4"
                              />
                            )}
                          </Show>
                        }
                      >
                        <span class="text-base">{group.emoji}</span>
                      </Show>
                      <span class="text-xs text-muted-foreground">
                        {group.reactors?.totalCount ?? 0}
                      </span>
                    </span>
                    <Show when={pending()}>
                      <span class="absolute inset-0 flex items-center justify-center">
                        <IconLoader2
                          class="size-4 animate-spin"
                          aria-hidden="true"
                        />
                      </span>
                    </Show>
                  </Button>
                );
              }}
            </For>
          </div>
        </div>
      </Show>

      {/* Emoji Grid */}
      <div class="space-y-2">
        <div class="grid grid-cols-8 gap-1">
          <For each={availableEmojis()}>
            {(emoji) => (
              <Button
                variant="ghost"
                size="sm"
                class="relative h-8 w-8 p-0 text-base hover:bg-accent cursor-pointer"
                disabled={isSubmitting()}
                title={isPendingTarget("emoji", emoji)
                  ? pendingStatus() ?? undefined
                  : t`React with ${emoji}`}
                onClick={() => handleEmojiClick(emoji)}
              >
                <span
                  classList={{ "opacity-30": isPendingTarget("emoji", emoji) }}
                >
                  {emoji}
                </span>
                <Show when={isPendingTarget("emoji", emoji)}>
                  <span class="absolute inset-0 flex items-center justify-center">
                    <IconLoader2
                      class="size-4 animate-spin"
                      aria-hidden="true"
                    />
                  </span>
                </Show>
              </Button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
