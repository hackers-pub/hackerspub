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
  class?: string;
  classList?: Record<string, boolean>;
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
        <div
          class={`flex items-center gap-1 p-2 border-t ${props.class ?? ""}`}
          classList={props.classList}
        >
          {/* Reply Button */}
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            title={t`Reply`}
          >
            <ReplyIcon class="size-4" />
            <span class="text-xs">{note().engagementStats.replies}</span>
          </Button>

          {/* Share Button */}
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            title={t`Share`}
          >
            <ShareIcon class="size-4" />
            <span class="text-xs">{note().engagementStats.shares}</span>
          </Button>

          {/* Quote Button */}
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            title={t`Quote`}
          >
            <QuoteIcon class="size-4" />
            <span class="text-xs">{note().engagementStats.quotes}</span>
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
              <HeartIcon class="size-4" filled={userHasReacted()} />
              <span class="text-xs">{note().engagementStats.reactions}</span>
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
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class={props.class}
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 0 1-.923 1.785A5.969 5.969 0 0 0 6 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337Z"
      />
    </svg>
  );
}

function ShareIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class={props.class}
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"
      />
    </svg>
  );
}

function QuoteIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class={props.class}
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"
      />
    </svg>
  );
}

function HeartIcon(props: { class?: string; filled?: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill={props.filled ? "currentColor" : "none"}
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class={props.class}
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"
      />
    </svg>
  );
}
