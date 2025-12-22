import { sortReactionGroups } from "@hackerspub/models/emoji";
import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconHeart from "~icons/lucide/heart";
import IconMessageSquare from "~icons/lucide/message-square";
import IconMessageSquareQuote from "~icons/lucide/message-square-quote";
import IconRepeat2 from "~icons/lucide/repeat-2";
import type { PostControls_note$key } from "./__generated__/PostControls_note.graphql.ts";
import type { PostControls_sharePost_Mutation } from "./__generated__/PostControls_sharePost_Mutation.graphql.ts";
import type { PostControls_unsharePost_Mutation } from "./__generated__/PostControls_unsharePost_Mutation.graphql.ts";
import { EmojiReactionPopover } from "./EmojiReactionPopover.tsx";

export interface PostControlsProps {
  $note: PostControls_note$key;
  class?: string;
  classList?: Record<string, boolean>;
}

const sharePostMutation = graphql`
  mutation PostControls_sharePost_Mutation($input: SharePostInput!) {
    sharePost(input: $input) {
      ... on SharePostPayload {
        originalPost {
          id
          viewerHasShared
          engagementStats {
            shares
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

const unsharePostMutation = graphql`
  mutation PostControls_unsharePost_Mutation($input: UnsharePostInput!) {
    unsharePost(input: $input) {
      ... on UnsharePostPayload {
        originalPost {
          id
          viewerHasShared
          engagementStats {
            shares
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
        viewerHasShared
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

  const [sharePost] = createMutation<PostControls_sharePost_Mutation>(
    sharePostMutation,
  );

  const [unsharePost] = createMutation<PostControls_unsharePost_Mutation>(
    unsharePostMutation,
  );

  const handleShareClick = () => {
    const noteData = note();
    if (!noteData) return;

    if (noteData.viewerHasShared) {
      unsharePost({
        variables: {
          input: {
            postId: noteData.id,
          },
        },
        onError(_error) {
          showToast({
            title: t`Failed to unshare post`,
            variant: "destructive",
          });
        },
      });
    } else {
      sharePost({
        variables: {
          input: {
            postId: noteData.id,
          },
        },
        onError(_error) {
          showToast({
            title: t`Failed to share post`,
            variant: "destructive",
          });
        },
      });
    }
  };
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
          class={`flex items-center justify-between gap-1 -mx-2 pr-20 ${
            props.class ?? ""
          }`}
          classList={props.classList}
        >
          {/* Reply Button */}
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            title={t`Reply`}
          >
            <IconMessageSquare class="size-4" />
            <span class="text-xs">{note().engagementStats.replies}</span>
          </Button>

          {/* Quote Button */}
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 text-muted-foreground hover:text-foreground cursor-pointer"
            title={t`Quote`}
          >
            <IconMessageSquareQuote class="size-4" />
            <span class="text-xs">{note().engagementStats.quotes}</span>
          </Button>

          {/* Share Button */}
          <Button
            variant="ghost"
            size="sm"
            class="h-8 px-2 cursor-pointer"
            classList={{
              "text-muted-foreground hover:text-foreground": !note()
                .viewerHasShared,
              "text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300":
                note().viewerHasShared,
            }}
            title={note().viewerHasShared ? t`Unshare` : t`Share`}
            onClick={handleShareClick}
          >
            <IconRepeat2 class="size-4" />
            <span class="text-xs">{note().engagementStats.shares}</span>
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
              <IconHeart class="size-4" />
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
