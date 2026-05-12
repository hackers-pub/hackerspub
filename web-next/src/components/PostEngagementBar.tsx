import { sortReactionGroups } from "@hackerspub/models/emoji";
import { A } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { createSignal, type JSX, Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip.tsx";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { PostEngagementBar_post$key } from "./__generated__/PostEngagementBar_post.graphql.ts";
import type { PostEngagementBar_sharePost_Mutation } from "./__generated__/PostEngagementBar_sharePost_Mutation.graphql.ts";
import type { PostEngagementBar_unsharePost_Mutation } from "./__generated__/PostEngagementBar_unsharePost_Mutation.graphql.ts";
import { BookmarkButton } from "./BookmarkButton.tsx";
import { EmojiReactionPopover } from "./EmojiReactionPopover.tsx";

export interface PostEngagementBarProps {
  $post: PostEngagementBar_post$key;
  /**
   * URL the reply control navigates to (e.g.
   * `/@dahlia/01HXY…/replies`).  When provided, the reply icon and
   * count form an `<A>` link to that URL.  When null (e.g. a
   * federated post with no local permalink), the reply control falls
   * back to opening the legacy in-modal composer instead.
   */
  repliesHref?: string | null;
  /**
   * Base path for the per-post engagement sub-routes (`/quotes`,
   * `/shares`, `/reactions`).  When provided, the quote/share/react
   * counts become links to the corresponding sub-pages; when null,
   * the counts render as plain text.  Wired separately from
   * {@link repliesHref} so the reply control can light up before the
   * other sub-routes ship.
   */
  engagementBase?: string | null;
  bookmarkListConnections?: string[];
  class?: string;
  classList?: Record<string, boolean>;
}

const sharePostMutation = graphql`
  mutation PostEngagementBar_sharePost_Mutation($input: SharePostInput!) {
    sharePost(input: $input) {
      __typename
      ... on SharePostPayload {
        originalPost {
          id
          viewerHasShared
          viewerCanShare
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
  mutation PostEngagementBar_unsharePost_Mutation(
    $input: UnsharePostInput!
  ) {
    unsharePost(input: $input) {
      __typename
      ... on UnsharePostPayload {
        originalPost {
          id
          viewerHasShared
          viewerCanShare
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

export function PostEngagementBar(props: PostEngagementBarProps) {
  const { t } = useLingui();
  const { openWithQuote, openWithReply } = useNoteCompose();
  const note = createFragment(
    graphql`
      fragment PostEngagementBar_post on Post {
        __id
        engagementStats {
          replies
          shares
          quotes
          reactions
        }
        id
        visibility
        viewerHasShared
        viewerCanReply
        viewerCanQuote
        viewerCanShare
        ...BookmarkButton_post
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
    () => props.$post,
  );

  const [showEmojiPopover, setShowEmojiPopover] = createSignal(false);

  const [sharePost, sharePending] = createMutation<
    PostEngagementBar_sharePost_Mutation
  >(sharePostMutation);
  const [unsharePost, unsharePending] = createMutation<
    PostEngagementBar_unsharePost_Mutation
  >(unsharePostMutation);
  const sharePendingAny = () => sharePending() || unsharePending();

  const handleShareClick = () => {
    const noteData = note();
    // Guard against duplicate dispatches while the previous share/unshare
    // round-trip is still in flight; Relay updates `viewerHasShared` only
    // after the response arrives.
    if (!noteData || sharePendingAny()) return;

    if (noteData.viewerHasShared) {
      unsharePost({
        variables: { input: { postId: noteData.id } },
        onCompleted(response) {
          if (response.unsharePost?.__typename !== "UnsharePostPayload") {
            showToast({
              title: t`Failed to unshare post`,
              variant: "destructive",
            });
          }
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
        variables: { input: { postId: noteData.id } },
        onCompleted(response) {
          if (response.sharePost?.__typename !== "SharePostPayload") {
            showToast({
              title: t`Failed to share post`,
              variant: "destructive",
            });
          }
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

  const reactionPopoverData = () => {
    const noteData = note();
    if (!noteData) return null;
    return {
      id: noteData.id,
      reactionGroups: sortedReactionGroups().map((group) => ({
        emoji: group.emoji,
        customEmoji: group.customEmoji == null ? undefined : {
          id: group.customEmoji.id,
          name: group.customEmoji.name,
          imageUrl: group.customEmoji.imageUrl,
        },
        reactors: group.reactors == null ? undefined : {
          totalCount: group.reactors.totalCount,
          viewerHasReacted: group.reactors.viewerHasReacted,
        },
      })),
    };
  };

  const userHasReacted = () => {
    const noteData = note();
    return noteData?.reactionGroups.some((group) =>
      group.reactors?.viewerHasReacted
    ) ?? false;
  };

  return (
    <Show keyed when={note()}>
      {(note) => (
        <div
          class={`mt-2 flex items-center justify-between gap-1 -mx-2 ${
            props.class ?? ""
          }`}
          classList={props.classList}
        >
          {
            /* Reply — whole control navigates to /replies when local,
              otherwise opens the legacy composer. */
          }
          <ReplyControl
            replies={note.engagementStats.replies}
            repliesHref={props.repliesHref ?? null}
            disabled={!note.viewerCanReply}
            visibility={note.visibility}
            postId={note.id}
            openWithReply={openWithReply}
            replyLabel={t`Reply`}
            disabledLabel={t`Replying is not available for this post`}
            viewLabel={t`View replies`}
          />

          {/* Quote — icon opens composer, count links to /quotes. */}
          <SplitControl
            disabled={!note.viewerCanQuote}
            engagementBase={props.engagementBase ?? null}
            segment="quotes"
            count={note.engagementStats.quotes}
            iconLabel={note.viewerCanQuote
              ? t`Quote`
              : t`Quoting is not available for this post`}
            countLabel={t`View quotes`}
            onIconClick={() => openWithQuote(note.id)}
            iconColor="text-muted-foreground hover:text-foreground"
            icon={
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="size-4"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"
                />
              </svg>
            }
          />

          {/* Share — icon toggles, count links to /shares. */}
          <SplitControl
            disabled={sharePendingAny() ||
              (!note.viewerHasShared && !note.viewerCanShare)}
            engagementBase={props.engagementBase ?? null}
            segment="shares"
            count={note.engagementStats.shares}
            iconLabel={note.viewerHasShared
              ? t`Unshare`
              : note.viewerCanShare
              ? t`Share`
              : t`Sharing is not available for this post`}
            countLabel={t`View shares`}
            onIconClick={handleShareClick}
            iconColor={note.viewerHasShared
              ? "text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
              : "text-muted-foreground hover:text-foreground"}
            icon={
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="size-4"
                aria-hidden="true"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"
                />
              </svg>
            }
          />

          {/* Reactions — icon opens emoji popover, count links to /reactions. */}
          <div class="inline-flex items-stretch">
            <DropdownMenu
              open={showEmojiPopover()}
              onOpenChange={setShowEmojiPopover}
            >
              <DropdownMenuTrigger
                class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 hover:bg-accent hover:text-accent-foreground h-8 px-2 cursor-pointer"
                classList={{
                  "text-muted-foreground hover:text-foreground":
                    !userHasReacted(),
                  "text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300":
                    userHasReacted(),
                }}
                aria-label={t`React`}
                title={t`React`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill={userHasReacted() ? "currentColor" : "none"}
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-4"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"
                  />
                </svg>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="w-80 p-0">
                <Show when={reactionPopoverData()}>
                  <EmojiReactionPopover
                    noteData={reactionPopoverData()!}
                    onClose={() => setShowEmojiPopover(false)}
                  />
                </Show>
              </DropdownMenuContent>
            </DropdownMenu>
            <CountAffordance
              count={note.engagementStats.reactions}
              engagementBase={props.engagementBase ?? null}
              segment="reactions"
              label={t`View reactions`}
            />
          </div>

          {
            /* Bookmark — whole control toggles, count rendered next to icon
              (no navigation page exists for bookmarks). */
          }
          <BookmarkButton
            $post={note}
            bookmarkListConnections={props.bookmarkListConnections}
          />
        </div>
      )}
    </Show>
  );
}

function ReplyControl(props: {
  replies: number;
  repliesHref: string | null;
  disabled: boolean;
  visibility: string;
  postId: string;
  openWithReply: (id: string, vis: PostVisibility) => void;
  replyLabel: string;
  disabledLabel: string;
  viewLabel: string;
}) {
  const tooltip = () => props.disabled ? props.disabledLabel : props.replyLabel;
  const buttonClasses =
    "inline-flex items-center justify-center gap-2 h-8 px-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 cursor-pointer";
  // The link variant adds `hover:underline` (and matching focus-visible
  // underline) so the reply control reads as a navigable link rather
  // than just another action button, mirroring `CountAffordance`.
  const linkClasses =
    `${buttonClasses} hover:underline focus-visible:underline`;

  const icon = (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke-width="1.5"
      stroke="currentColor"
      class="size-4"
      aria-hidden="true"
    >
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"
      />
    </svg>
  );

  // When a replies URL is available, the reply control is always a
  // navigation link to the conversation page — even for guests or viewers
  // who cannot post a reply themselves; the conversation is public-readable
  // under the same rules as the post.  Only the legacy compose-fallback
  // branch (no repliesHref) honours `viewerCanReply`, because that branch
  // can only invoke the composer and has nowhere else to take the viewer.
  return (
    <Tooltip>
      <TooltipTrigger as="span" class="inline-flex">
        <Show
          when={props.repliesHref}
          fallback={
            <button
              type="button"
              class={buttonClasses}
              disabled={props.disabled}
              aria-label={tooltip()}
              onClick={() => {
                const v = props.visibility;
                const vis: PostVisibility =
                  v === "PUBLIC" || v === "UNLISTED" ||
                    v === "FOLLOWERS" || v === "DIRECT"
                    ? v
                    : "PUBLIC";
                props.openWithReply(props.postId, vis);
              }}
            >
              {icon}
              <span class="text-xs">{props.replies}</span>
            </button>
          }
        >
          <A
            href={props.repliesHref!}
            class={linkClasses}
            aria-label={props.viewLabel}
          >
            {icon}
            <span class="text-xs">{props.replies}</span>
          </A>
        </Show>
      </TooltipTrigger>
      <TooltipContent>
        {props.repliesHref ? props.viewLabel : tooltip()}
      </TooltipContent>
    </Tooltip>
  );
}

function SplitControl(props: {
  disabled: boolean;
  engagementBase: string | null;
  segment: string;
  count: number;
  iconLabel: string;
  countLabel: string;
  onIconClick: () => void;
  iconColor: string;
  icon: JSX.Element;
}) {
  return (
    <div class="inline-flex items-stretch">
      <Tooltip>
        <TooltipTrigger as="span" class="inline-flex">
          <Button
            variant="ghost"
            size="sm"
            disabled={props.disabled}
            aria-label={props.iconLabel}
            class={`h-8 px-2 cursor-pointer ${props.iconColor}`}
            onClick={props.onIconClick}
          >
            {props.icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{props.iconLabel}</TooltipContent>
      </Tooltip>
      <CountAffordance
        count={props.count}
        engagementBase={props.engagementBase}
        segment={props.segment}
        label={props.countLabel}
      />
    </div>
  );
}

function CountAffordance(props: {
  count: number;
  engagementBase: string | null;
  segment: string;
  label: string;
}) {
  const text = (
    <span class="inline-flex items-center px-1 text-xs">{props.count}</span>
  );
  // Distinct affordance from the neighbouring icon button so the count
  // reads as a navigable link instead of part of the button:
  //   - `hover:underline` makes the link nature explicit on pointer
  //     devices (Twitter/Mastodon convention).
  //   - `hover:shadow-[inset_1px_0_0_0_var(--border)]` adds a thin left
  //     edge that only materialises on hover, so the static layout
  //     stays unchanged (the shadow doesn't take box-model space) but
  //     mouse users get a clear "two zones" read when they pass between
  //     the icon and the count.
  return (
    <Show when={props.engagementBase} fallback={text}>
      <A
        href={`${props.engagementBase}/${props.segment}`}
        class="inline-flex items-center px-1 text-xs rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground hover:underline hover:shadow-[inset_1px_0_0_0_var(--border)] focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={props.label}
      >
        {props.count}
      </A>
    </Show>
  );
}
