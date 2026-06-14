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
import { RefreshFromOriginItem } from "~/components/RefreshFromOriginItem.tsx";
import { ReportDialog } from "~/components/ReportDialog.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconEllipsis from "~icons/lucide/ellipsis";
import IconFlag from "~icons/lucide/flag";
import IconPencil from "~icons/lucide/pencil";
import IconPin from "~icons/lucide/pin";
import IconPinOff from "~icons/lucide/pin-off";
import IconTrash2 from "~icons/lucide/trash-2";
import type { PostActionMenu_deletePost_Mutation } from "./__generated__/PostActionMenu_deletePost_Mutation.graphql.ts";
import type { PostActionMenu_post$key } from "./__generated__/PostActionMenu_post.graphql.ts";
import type { PostActionMenu_pinPost_Mutation } from "./__generated__/PostActionMenu_pinPost_Mutation.graphql.ts";
import type { PostActionMenu_question$key } from "./__generated__/PostActionMenu_question.graphql.ts";
import type { PostActionMenu_unpinPost_Mutation } from "./__generated__/PostActionMenu_unpinPost_Mutation.graphql.ts";

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

const pinPostMutation = graphql`
  mutation PostActionMenu_pinPost_Mutation(
    $input: PinPostInput!
    $connections: [ID!]!
    $locale: Locale
  ) {
    pinPost(input: $input) {
      __typename
      ... on PinPostPayload {
        post
          @prependNode(
            connections: $connections
            edgeTypeName: "ActorPinsConnectionEdge"
          ) {
          id
          viewerHasPinned
          ...PostCard_post @arguments(locale: $locale)
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

const unpinPostMutation = graphql`
  mutation PostActionMenu_unpinPost_Mutation(
    $input: UnpinPostInput!
    $connections: [ID!]!
  ) {
    unpinPost(input: $input) {
      __typename
      ... on UnpinPostPayload {
        post {
          id
          viewerHasPinned
        }
        unpinnedPostId @deleteEdge(connections: $connections)
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
  pinConnections?: string[];
  onDeleted?: () => void;
  onEdit?: () => void;
}

interface PostActionMenuData {
  readonly id: string;
  readonly iri: string;
  readonly visibility: string;
  readonly viewerHasPinned: boolean;
  readonly sharedPost: { readonly id: string } | null | undefined;
  readonly actor: {
    readonly isViewer: boolean;
    readonly local: boolean;
    readonly handle: string;
  };
}

export function PostActionMenu(props: PostActionMenuProps) {
  const post = createFragment(
    graphql`
      fragment PostActionMenu_post on Post {
        id
        iri
        visibility
        viewerHasPinned
        sharedPost {
          id
        }
        actor {
          isViewer
          local
          handle
        }
      }
    `,
    () => props.$post,
  );

  return (
    <PostActionMenuContent
      post={post}
      connections={props.connections}
      pinConnections={props.pinConnections}
      onDeleted={props.onDeleted}
      onEdit={props.onEdit}
    />
  );
}

export interface QuestionActionMenuProps {
  $question: PostActionMenu_question$key;
  connections?: string[];
  pinConnections?: string[];
  onDeleted?: () => void;
  onEdit?: () => void;
}

export function QuestionActionMenu(props: QuestionActionMenuProps) {
  const question = createFragment(
    graphql`
      fragment PostActionMenu_question on Question {
        id
        iri
        visibility
        viewerHasPinned
        sharedPost {
          id
        }
        actor {
          isViewer
          local
          handle
        }
      }
    `,
    () => props.$question,
  );

  return (
    <PostActionMenuContent
      post={question}
      connections={props.connections}
      pinConnections={props.pinConnections}
      onDeleted={props.onDeleted}
      onEdit={props.onEdit}
    />
  );
}

interface PostActionMenuContentProps {
  post: () => PostActionMenuData | null | undefined;
  connections?: string[];
  pinConnections?: string[];
  onDeleted?: () => void;
  onEdit?: () => void;
}

function PostActionMenuContent(props: PostActionMenuContentProps) {
  const { i18n, t } = useLingui();
  const viewer = useViewer();
  const post = props.post;
  const [showConfirm, setShowConfirm] = createSignal(false);
  const [showReport, setShowReport] = createSignal(false);

  // The author manages their own post (edit/pin/delete); a moderator may
  // additionally force-refresh a remote post they did not author.
  const isAuthor = () => post()?.actor.isViewer ?? false;
  const canModerate = () => {
    const p = post();
    return viewer.moderator() && p != null && !p.actor.local;
  };
  // Anyone signed in can report someone else's post.  Boost wrappers are
  // not reportable themselves; report the boosted post instead.
  const canReport = () => {
    const p = post();
    return viewer.isLoaded() && viewer.isAuthenticated() && p != null &&
      !p.actor.isViewer && p.sharedPost == null;
  };

  const [commitDeletePost, isDeleting] = createMutation<
    PostActionMenu_deletePost_Mutation
  >(deletePostMutation);
  const [commitPinPost, isPinning] = createMutation<
    PostActionMenu_pinPost_Mutation
  >(pinPostMutation);
  const [commitUnpinPost, isUnpinning] = createMutation<
    PostActionMenu_unpinPost_Mutation
  >(unpinPostMutation);

  const canPinPost = () => {
    const p = post();
    return p != null &&
      p.actor.isViewer &&
      p.sharedPost == null &&
      (p.visibility === "PUBLIC" || p.visibility === "UNLISTED");
  };

  const handlePinToggle = () => {
    const p = post();
    if (!p || !canPinPost()) return;

    if (p.viewerHasPinned) {
      commitUnpinPost({
        variables: {
          input: { postId: p.id },
          connections: props.pinConnections ?? [],
        },
        onCompleted(response) {
          if (response.unpinPost.__typename === "UnpinPostPayload") {
            showToast({ title: t`Post unpinned` });
          } else {
            showToast({
              title: t`Failed to unpin post`,
              variant: "destructive",
            });
          }
        },
        onError() {
          showToast({
            title: t`Failed to unpin post`,
            variant: "destructive",
          });
        },
      });
    } else {
      commitPinPost({
        variables: {
          input: { postId: p.id },
          connections: props.pinConnections ?? [],
          locale: i18n.locale,
        },
        onCompleted(response) {
          if (response.pinPost.__typename === "PinPostPayload") {
            showToast({ title: t`Post pinned` });
          } else {
            showToast({
              title: t`Failed to pin post`,
              variant: "destructive",
            });
          }
        },
        onError() {
          showToast({
            title: t`Failed to pin post`,
            variant: "destructive",
          });
        },
      });
    }
  };

  const handleDelete = () => {
    const p = post();
    if (!p) return;

    commitDeletePost({
      variables: {
        input: { id: p.id },
        connections: [
          ...new Set([
            ...(props.connections ?? []),
            ...(props.pinConnections ?? []),
          ]),
        ],
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
    <Show when={isAuthor() || canModerate() || canReport()}>
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
          <Show when={canModerate()}>
            <RefreshFromOriginItem uri={post()!.iri} />
          </Show>
          <Show when={props.onEdit != null && isAuthor()}>
            <DropdownMenuItem class="cursor-pointer" onSelect={props.onEdit}>
              <IconPencil class="size-4" />
              {t`Edit`}
            </DropdownMenuItem>
          </Show>
          <Show when={canPinPost()}>
            <DropdownMenuItem
              class="cursor-pointer"
              disabled={isPinning() || isUnpinning()}
              onSelect={handlePinToggle}
            >
              <Show
                when={post()?.viewerHasPinned}
                fallback={<IconPin class="size-4" />}
              >
                <IconPinOff class="size-4" />
              </Show>
              <Show when={post()?.viewerHasPinned} fallback={t`Pin to profile`}>
                {t`Unpin from profile`}
              </Show>
            </DropdownMenuItem>
          </Show>
          <Show when={isAuthor()}>
            <DropdownMenuItem
              class="text-destructive focus:text-destructive cursor-pointer"
              onSelect={() => setShowConfirm(true)}
            >
              <IconTrash2 class="size-4" />
              {t`Delete`}
            </DropdownMenuItem>
          </Show>
          <Show when={canReport()}>
            <DropdownMenuItem
              class="cursor-pointer text-error-foreground focus:bg-error focus:text-error-foreground"
              onSelect={() => setShowReport(true)}
            >
              <IconFlag class="size-4" />
              {t`Report`}
            </DropdownMenuItem>
          </Show>
        </DropdownMenuContent>
      </DropdownMenu>

      <Show when={canReport()}>
        <ReportDialog
          open={showReport()}
          onOpenChange={setShowReport}
          targetId={post()!.id}
          targetKind="post"
          targetHandle={post()!.actor.handle}
          targetIsRemote={!post()!.actor.local}
        />
      </Show>

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
