import { sortReactionGroups } from "@hackerspub/models/emoji";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { EmojiReactionPopover } from "./EmojiReactionPopover.tsx";
import type { PostControls_note$key } from "./__generated__/PostControls_note.graphql.ts";

export interface PostControlsProps {
  $note: PostControls_note$key;
}

export function PostControls(props: PostControlsProps) {
  const { t } = useLingui();
  const note = createFragment(
    graphql`
      fragment PostControls_note on Note {
        __id
        engagementStats {
          replies
          shares
          quotes
          reactions
        }
        id
        reactionGroups {
          ... on EmojiReactionGroup {
            emoji
            reactors {
              totalCount
              viewerHasReacted
            }
          }
          ... on CustomEmojiReactionGroup {
            customEmoji {
              id
              name
              imageUrl
            }
            reactors {
              totalCount
              viewerHasReacted
            }
          }
        }
      }
    `,
    () => props.$note,
  );

  const [showEmojiPopover, setShowEmojiPopover] = createSignal(false);

  const sortedReactionGroups = () => {
    const noteData = note();
    return sortReactionGroups(noteData?.reactionGroups || []);
  };

  const userHasReacted = () => {
    const noteData = note();
    return noteData?.reactionGroups.some((group) =>
      group.reactors?.viewerHasReacted
    ) ??
      false;
  };

  return (
    <Show when={note()}>
      {(note) => (
        <div class="flex items-center gap-1 px-4 pb-4">
          {/* Reply Button */}
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            title={t`Reply`}
          >
            <ReplyIcon class="size-4" />
            <span class="ml-1 text-xs">{note().engagementStats.replies}</span>
          </Button>

          {/* Share Button */}
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            title={t`Share`}
          >
            <ShareIcon class="size-4" />
            <span class="ml-1 text-xs">{note().engagementStats.shares}</span>
          </Button>

          {/* Quote Button */}
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            title={t`Quote`}
          >
            <QuoteIcon class="size-4" />
            <span class="ml-1 text-xs">{note().engagementStats.quotes}</span>
          </Button>

          {/* Reactions Button */}
          <DropdownMenu
            open={showEmojiPopover()}
            onOpenChange={setShowEmojiPopover}
          >
            <DropdownMenuTrigger
              class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-8 px-2 cursor-pointer"
              classList={{
                "text-muted-foreground hover:text-foreground":
                  !userHasReacted(),
                "text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300":
                  userHasReacted(),
              }}
              title={t`React`}
            >
              <HeartIcon class="size-4" />
              <span class="ml-1 text-xs">
                {note().engagementStats.reactions}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="w-80 p-0">
              <EmojiReactionPopover
                noteData={{
                  ...note(),
                  reactionGroups: sortedReactionGroups(),
                }}
                onClose={() => setShowEmojiPopover(false)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </Show>
  );
}

// Icon Components
function ReplyIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M3 20L3 4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H6l-3 3z" />
      <path d="m8 12 2-2 2 2" />
    </svg>
  );
}

function ShareIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16,6 12,2 8,6" />
      <line x1="12" x2="12" y1="2" y2="15" />
    </svg>
  );
}

function QuoteIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
      <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
    </svg>
  );
}

function HeartIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z" />
    </svg>
  );
}
