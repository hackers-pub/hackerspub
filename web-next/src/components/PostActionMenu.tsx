import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconEllipsis from "~icons/lucide/ellipsis";
import IconTrash2 from "~icons/lucide/trash-2";
import type { PostActionMenu_deletePost_Mutation } from "./__generated__/PostActionMenu_deletePost_Mutation.graphql.ts";
import type { PostActionMenu_post$key } from "./__generated__/PostActionMenu_post.graphql.ts";

const deletePostMutation = graphql`
  mutation PostActionMenu_deletePost_Mutation(
    $input: DeletePostInput!
    $connections: [ID!]!
  ) {
    deletePost(input: $input) {
      ... on DeletePostPayload {
        deletedPostId @deleteEdge(connections: $connections)
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

export interface PostActionMenuProps {
  $post: PostActionMenu_post$key;
  connections?: string[];
  onDeleted?: () => void;
}

export function PostActionMenu(props: PostActionMenuProps) {
  const { t } = useLingui();
  const post = createFragment(
    graphql`
      fragment PostActionMenu_post on Post {
        id
        actor {
          isViewer
        }
      }
    `,
    () => props.$post,
  );

  const [showConfirm, setShowConfirm] = createSignal(false);

  const [commitDeletePost, isDeleting] = createMutation<
    PostActionMenu_deletePost_Mutation
  >(deletePostMutation);

  const handleDelete = () => {
    const p = post();
    if (!p) return;

    commitDeletePost({
      variables: {
        input: { id: p.id },
        connections: props.connections ?? [],
      },
      onCompleted(response) {
        if (response.deletePost.deletedPostId != null) {
          showToast({ title: t`Post deleted` });
          props.onDeleted?.();
        } else {
          showToast({
            title: t`Failed to delete post`,
            variant: "destructive",
          });
        }
      },
      onError() {
        showToast({
          title: t`Failed to delete post`,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <Show when={post()?.actor.isViewer}>
      <DropdownMenu>
        <DropdownMenuTrigger
          as={(triggerProps: Record<string, unknown>) => (
            <Button
              variant="ghost"
              size="sm"
              class="h-6 w-6 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
              {...triggerProps}
            >
              <IconEllipsis class="size-4" />
            </Button>
          )}
        />
        <DropdownMenuContent>
          <DropdownMenuItem
            class="text-destructive-foreground focus:text-destructive-foreground cursor-pointer"
            onSelect={() => setShowConfirm(true)}
          >
            <IconTrash2 class="size-4" />
            {t`Delete`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={showConfirm()} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Delete post?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`This action cannot be undone. This will permanently delete this post.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>{t`Cancel`}</AlertDialogClose>
            <AlertDialogAction
              class="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleDelete}
              disabled={isDeleting()}
            >
              {t`Delete`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Show>
  );
}
