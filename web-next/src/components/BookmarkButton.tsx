import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { BookmarkButton_bookmarkPost_Mutation } from "./__generated__/BookmarkButton_bookmarkPost_Mutation.graphql.ts";
import type { BookmarkButton_post$key } from "./__generated__/BookmarkButton_post.graphql.ts";
import type { BookmarkButton_unbookmarkPost_Mutation } from "./__generated__/BookmarkButton_unbookmarkPost_Mutation.graphql.ts";

export interface BookmarkButtonProps {
  $post: BookmarkButton_post$key;
  bookmarkListConnections?: string[];
  class?: string;
}

const bookmarkPostMutation = graphql`
  mutation BookmarkButton_bookmarkPost_Mutation($input: BookmarkPostInput!) {
    bookmarkPost(input: $input) {
      __typename
      ... on BookmarkPostPayload {
        post {
          id
          viewerHasBookmarked
          engagementStats {
            bookmarks
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

const unbookmarkPostMutation = graphql`
  mutation BookmarkButton_unbookmarkPost_Mutation(
    $input: UnbookmarkPostInput!
    $connections: [ID!]!
  ) {
    unbookmarkPost(input: $input) {
      __typename
      ... on UnbookmarkPostPayload {
        post {
          id
          viewerHasBookmarked
          engagementStats {
            bookmarks
          }
        }
        unbookmarkedPostId @deleteEdge(connections: $connections)
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

export function BookmarkButton(props: BookmarkButtonProps) {
  const { t } = useLingui();
  const post = createFragment(
    graphql`
      fragment BookmarkButton_post on Post {
        id
        viewerHasBookmarked
        engagementStats {
          bookmarks
        }
      }
    `,
    () => props.$post,
  );

  const [bookmarkPost] =
    createMutation<BookmarkButton_bookmarkPost_Mutation>(bookmarkPostMutation);
  const [unbookmarkPost] =
    createMutation<BookmarkButton_unbookmarkPost_Mutation>(
      unbookmarkPostMutation,
    );

  const handleClick = () => {
    const p = post();
    if (!p) return;

    if (p.viewerHasBookmarked) {
      unbookmarkPost({
        variables: {
          input: { postId: p.id },
          connections: props.bookmarkListConnections ?? [],
        },
        onCompleted(response) {
          if (response.unbookmarkPost.__typename !== "UnbookmarkPostPayload") {
            showToast({
              title: t`Failed to remove bookmark`,
              variant: "destructive",
            });
          }
        },
        onError(_error) {
          showToast({
            title: t`Failed to remove bookmark`,
            variant: "destructive",
          });
        },
      });
    } else {
      bookmarkPost({
        variables: {
          input: { postId: p.id },
        },
        onCompleted(response) {
          if (response.bookmarkPost.__typename !== "BookmarkPostPayload") {
            showToast({
              title: t`Failed to bookmark`,
              variant: "destructive",
            });
          }
        },
        onError(_error) {
          showToast({
            title: t`Failed to bookmark`,
            variant: "destructive",
          });
        },
      });
    }
  };

  return (
    <Show keyed when={post()}>
      {(p) => (
        <Button
          variant="ghost"
          size="sm"
          class={`h-8 px-2 cursor-pointer ${props.class ?? ""}`}
          classList={{
            "text-muted-foreground hover:text-foreground":
              !p.viewerHasBookmarked,
            "text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300":
              p.viewerHasBookmarked,
          }}
          aria-label={p.viewerHasBookmarked ? t`Remove bookmark` : t`Bookmark`}
          title={p.viewerHasBookmarked ? t`Remove bookmark` : t`Bookmark`}
          onClick={handleClick}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill={p.viewerHasBookmarked ? "currentColor" : "none"}
            viewBox="0 0 24 24"
            stroke-width="1.5"
            stroke="currentColor"
            class="size-4"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z"
            />
          </svg>
          <span class="text-xs">{p.engagementStats.bookmarks}</span>
        </Button>
      )}
    </Show>
  );
}
