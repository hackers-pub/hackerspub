import { REACTION_EMOJIS, sortReactionGroups } from "@hackerspub/models/emoji";
import { graphql } from "relay-runtime";
import { createSignal, For, Show } from "solid-js";
import { createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
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
    readonly count?: number;
    readonly viewerHasReacted?: boolean;
  }>;
}

export interface EmojiReactionPopoverProps {
  noteData: NoteData;
  onClose: () => void;
}

const addReactionToPostMutation = graphql`
  mutation EmojiReactionPopoverAddMutation($input: AddReactionToPostInput!) {
    addReactionToPost(input: $input) {
      ... on AddReactionToPostPayload {
        reaction {
          id
          emoji
          customEmoji {
            id
            name
            imageUrl
          }
          actor {
            id
            name
          }
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
  const [isSubmitting, setIsSubmitting] = createSignal(false);

  const [commitAddReaction] = createMutation<EmojiReactionPopoverAddMutation>(
    addReactionToPostMutation,
  );

  const [commitRemoveReaction] = createMutation<
    EmojiReactionPopoverRemoveMutation
  >(
    removeReactionFromPostMutation,
  );

  const handleEmojiClick = async (emoji: string) => {
    if (isSubmitting()) return;

    setIsSubmitting(true);
    try {
      // Check if user has already reacted with this emoji
      const existingReaction = props.noteData.reactionGroups.find((group) => {
        if (group.emoji) {
          return group.emoji === emoji;
        }
        return false;
      });

      // Toggle: if user has reacted, undo; if not, add
      const shouldUndo = existingReaction?.viewerHasReacted;

      if (shouldUndo) {
        commitRemoveReaction({
          variables: {
            input: {
              postId: props.noteData.id,
              emoji,
            },
          },
          updater: (store) => {
            // Handle undo reaction
            const postRecord = store.get(props.noteData.id);
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
                  const currentCount =
                    existingGroup.getValue("count") as number || 0;
                  if (currentCount <= 1) {
                    // Remove the group entirely
                    const updatedGroups = reactionGroups.filter((_, index) =>
                      index !== existingGroupIndex
                    );
                    postRecord.setLinkedRecords(
                      updatedGroups,
                      "reactionGroups",
                    );
                    // Also delete the group record from the store
                    store.delete(existingGroup.getDataID());
                  } else {
                    // Decrement count and mark as not reacted
                    existingGroup.setValue(currentCount - 1, "count");
                    existingGroup.setValue(false, "viewerHasReacted");
                  }
                }
              }
            }
          },
          onCompleted: (result) => {
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
              postId: props.noteData.id,
              emoji,
            },
          },
          updater: (store) => {
            // Handle add reaction
            const postRecord = store.get(props.noteData.id);
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
                  const currentCount =
                    existingGroup.getValue("count") as number || 0;
                  existingGroup.setValue(currentCount + 1, "count");
                  existingGroup.setValue(true, "viewerHasReacted");
                }
              } else {
                // Create new reaction group
                const newGroup = store.create(
                  `${props.noteData.id}_reaction_${emoji}`,
                  "EmojiReactionGroup",
                );
                newGroup.setValue(emoji, "emoji");
                newGroup.setValue(1, "count");
                newGroup.setValue(true, "viewerHasReacted");
                newGroup.setLinkedRecord(postRecord, "subject");

                const updatedGroups = [...reactionGroups, newGroup];
                postRecord.setLinkedRecords(updatedGroups, "reactionGroups");
              }
            }
          },
          onCompleted: (result) => {
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
            console.error("Failed to add reaction:", error);
            showToast({
              title: t`Failed to react`,
              description: t`Unable to add reaction. Please try again.`,
              variant: "error",
            });
          },
        });
      }
    } finally {
      setIsSubmitting(false);
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
    <div class="p-4 space-y-4">
      {/* Existing Reactions */}
      <Show when={sortedReactionGroups().length > 0}>
        <div class="space-y-2">
          <div class="flex flex-wrap gap-2">
            <For each={sortedReactionGroups()}>
              {(group) => (
                <Button
                  variant={group.viewerHasReacted === true
                    ? "secondary"
                    : "outline"}
                  size="sm"
                  class="h-8 gap-2 cursor-pointer"
                  disabled={isSubmitting()}
                  title={group.viewerHasReacted === true
                    ? t`Remove ${
                      group.emoji || group.customEmoji?.name || t`reaction`
                    }`
                    : t`Add ${
                      group.emoji || group.customEmoji?.name || t`reaction`
                    }`}
                  onClick={() => {
                    if ("emoji" in group && group.emoji) {
                      handleEmojiClick(group.emoji);
                    }
                  }}
                >
                  <Show
                    when={group.emoji}
                    fallback={
                      <Show when={group.customEmoji}>
                        {(customEmoji) => (
                          <img
                            src={customEmoji().imageUrl}
                            alt={customEmoji().name}
                            class="size-4"
                          />
                        )}
                      </Show>
                    }
                  >
                    <span class="text-base">{group.emoji}</span>
                  </Show>
                  <span class="text-xs text-muted-foreground">
                    {group.count ?? 0}
                  </span>
                </Button>
              )}
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
                class="h-8 w-8 p-0 text-base hover:bg-accent cursor-pointer"
                disabled={isSubmitting()}
                title={t`React with ${emoji}`}
                onClick={() => handleEmojiClick(emoji)}
              >
                {emoji}
              </Button>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
