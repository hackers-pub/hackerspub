import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconBookmark from "~icons/lucide/bookmark";
import IconBookmarkCheck from "~icons/lucide/bookmark-check";
import type { BookmarkButton_bookmarkPost_Mutation } from "./__generated__/BookmarkButton_bookmarkPost_Mutation.graphql.ts";
import type { BookmarkButton_post$key } from "./__generated__/BookmarkButton_post.graphql.ts";
import type { BookmarkButton_unbookmarkPost_Mutation } from "./__generated__/BookmarkButton_unbookmarkPost_Mutation.graphql.ts";

export interface BookmarkButtonProps {
  $post: BookmarkButton_post$key;
  connections?: string[];
  class?: string;
}

const bookmarkPostMutation = graphql`
  mutation BookmarkButton_bookmarkPost_Mutation($input: BookmarkPostInput!) {
    bookmarkPost(input: $input) {
      ... on BookmarkPostPayload {
        post {
          id
          viewerHasBookmarked
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
      ... on UnbookmarkPostPayload {
        post {
          id
          viewerHasBookmarked
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
      }
    `,
    () => props.$post,
  );

  const [bookmarkPost] = createMutation<BookmarkButton_bookmarkPost_Mutation>(
    bookmarkPostMutation,
  );
  const [unbookmarkPost] = createMutation<
    BookmarkButton_unbookmarkPost_Mutation
  >(unbookmarkPostMutation);

  const handleClick = () => {
    const p = post();
    if (!p) return;

    if (p.viewerHasBookmarked) {
      unbookmarkPost({
        variables: {
          input: { postId: p.id },
          connections: props.connections ?? [],
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
    <Show when={post()}>
      {(p) => (
        <Button
          variant="ghost"
          size="sm"
          class={`h-8 px-2 cursor-pointer ${props.class ?? ""}`}
          classList={{
            "text-muted-foreground hover:text-foreground": !p()
              .viewerHasBookmarked,
            "text-amber-600 hover:text-amber-700 dark:text-amber-400 dark:hover:text-amber-300":
              p().viewerHasBookmarked,
          }}
          title={p().viewerHasBookmarked ? t`Remove bookmark` : t`Bookmark`}
          onClick={handleClick}
        >
          <Show
            when={p().viewerHasBookmarked}
            fallback={<IconBookmark class="size-4" />}
          >
            <IconBookmarkCheck class="size-4" />
          </Show>
        </Button>
      )}
    </Show>
  );
}
