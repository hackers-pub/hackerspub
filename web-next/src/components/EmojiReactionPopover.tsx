import { REACTION_EMOJIS, sortReactionGroups } from "@hackerspub/models/emoji";
import { For, Show } from "solid-js";
import IconLoader2 from "~icons/lucide/loader-2";
import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { ReactionToggle } from "./createReactionToggle.ts";

interface NoteData {
  id: string;
  reactionGroups: ReadonlyArray<{
    readonly __typename?: string;
    readonly emoji?: string;
    readonly customEmoji?:
      | {
          readonly id: string;
          readonly name: string;
          readonly imageUrl: string;
        }
      | undefined;
    readonly reactors?: {
      readonly totalCount: number;
      readonly viewerHasReacted: boolean;
    };
  }>;
}

export interface EmojiReactionPopoverProps {
  noteData: NoteData;
  /**
   * Shared toggle instance owned by the surrounding engagement bar, so
   * the popover and the quick-pick bar report one pending state and
   * cannot double-submit against the same post.
   */
  toggle: ReactionToggle;
  onClose: () => void;
}

export function EmojiReactionPopover(props: EmojiReactionPopoverProps) {
  const { t } = useLingui();

  const isSubmitting = () => props.toggle.submitting();
  const pendingStatus = () => props.toggle.pendingStatus();
  const isPendingTarget = (kind: "emoji" | "customEmoji", id: string) =>
    props.toggle.isPendingTarget(kind, id);

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
    <div class="p-4 space-y-4" aria-busy={isSubmitting()}>
      {/* Existing Reactions */}
      <Show when={sortedReactionGroups().length > 0}>
        <div class="space-y-2">
          <div class="flex flex-wrap gap-2">
            <For each={sortedReactionGroups()}>
              {(group) => {
                const target = () =>
                  group.emoji == null
                    ? group.customEmoji == null
                      ? null
                      : {
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
                    variant={
                      group.reactors?.viewerHasReacted === true
                        ? "secondary"
                        : "outline"
                    }
                    size="sm"
                    class={
                      group.reactors?.viewerHasReacted === true
                        ? "relative h-8 gap-2 cursor-pointer border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/60"
                        : "relative h-8 gap-2 cursor-pointer"
                    }
                    disabled={isSubmitting()}
                    title={
                      pending()
                        ? (pendingStatus() ?? undefined)
                        : group.reactors?.viewerHasReacted === true
                          ? t`Remove ${
                              group.emoji ||
                              group.customEmoji?.name ||
                              t`reaction`
                            }`
                          : t`Add ${
                              group.emoji ||
                              group.customEmoji?.name ||
                              t`reaction`
                            }`
                    }
                    onClick={() => {
                      if (group.emoji) {
                        props.toggle.toggleEmoji(group.emoji);
                      } else if (group.customEmoji) {
                        props.toggle.toggleCustomEmoji(group.customEmoji.id);
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
                title={
                  isPendingTarget("emoji", emoji)
                    ? (pendingStatus() ?? undefined)
                    : t`React with ${emoji}`
                }
                onClick={() => props.toggle.toggleEmoji(emoji)}
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
