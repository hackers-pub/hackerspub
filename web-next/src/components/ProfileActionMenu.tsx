import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import IconBan from "~icons/lucide/ban";
import IconFlag from "~icons/lucide/flag";
import IconEllipsis from "~icons/lucide/ellipsis";
import IconUndo2 from "~icons/lucide/undo-2";
import IconUserMinus from "~icons/lucide/user-minus";
import IconVolume2 from "~icons/lucide/volume-2";
import IconVolumeX from "~icons/lucide/volume-x";
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
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  holdProfileContentGate,
  releaseProfileContentGate,
  revalidateProfileContent,
} from "~/lib/profileContentQueries.ts";
import type { ProfileActionMenu_actor$key } from "./__generated__/ProfileActionMenu_actor.graphql.ts";
import type { ProfileActionMenu_blockActor_Mutation } from "./__generated__/ProfileActionMenu_blockActor_Mutation.graphql.ts";
import type { ProfileActionMenu_muteActor_Mutation } from "./__generated__/ProfileActionMenu_muteActor_Mutation.graphql.ts";
import type { ProfileActionMenu_removeFollower_Mutation } from "./__generated__/ProfileActionMenu_removeFollower_Mutation.graphql.ts";
import type { ProfileActionMenu_unblockActor_Mutation } from "./__generated__/ProfileActionMenu_unblockActor_Mutation.graphql.ts";
import type { ProfileActionMenu_unmuteActor_Mutation } from "./__generated__/ProfileActionMenu_unmuteActor_Mutation.graphql.ts";

export interface ProfileActionMenuProps {
  $actor: ProfileActionMenu_actor$key;
}

const blockActorMutation = graphql`
  mutation ProfileActionMenu_blockActor_Mutation(
    $input: BlockActorInput!
    $actingAccountId: ID
  ) {
    blockActor(input: $input) {
      __typename
      ... on BlockActorPayload {
        blockee {
          id
          viewerBlocks(actingAccountId: $actingAccountId)
          blocksViewer(actingAccountId: $actingAccountId)
          viewerFollows(actingAccountId: $actingAccountId)
          followsViewer(actingAccountId: $actingAccountId)
          followersCount: followers {
            totalCount
          }
          followeesCount: followees {
            totalCount
          }
        }
        blocker {
          id
          viewerBlocks(actingAccountId: $actingAccountId)
          blocksViewer(actingAccountId: $actingAccountId)
          viewerFollows(actingAccountId: $actingAccountId)
          followsViewer(actingAccountId: $actingAccountId)
          followersCount: followers {
            totalCount
          }
          followeesCount: followees {
            totalCount
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

const unblockActorMutation = graphql`
  mutation ProfileActionMenu_unblockActor_Mutation(
    $input: UnblockActorInput!
    $actingAccountId: ID
  ) {
    unblockActor(input: $input) {
      __typename
      ... on UnblockActorPayload {
        blockee {
          id
          viewerBlocks(actingAccountId: $actingAccountId)
          blocksViewer(actingAccountId: $actingAccountId)
          viewerFollows(actingAccountId: $actingAccountId)
          followsViewer(actingAccountId: $actingAccountId)
          followersCount: followers {
            totalCount
          }
          followeesCount: followees {
            totalCount
          }
        }
        blocker {
          id
          viewerBlocks(actingAccountId: $actingAccountId)
          blocksViewer(actingAccountId: $actingAccountId)
          viewerFollows(actingAccountId: $actingAccountId)
          followsViewer(actingAccountId: $actingAccountId)
          followersCount: followers {
            totalCount
          }
          followeesCount: followees {
            totalCount
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

const muteActorMutation = graphql`
  mutation ProfileActionMenu_muteActor_Mutation(
    $input: MuteActorInput!
    $actingAccountId: ID
  ) {
    muteActor(input: $input) {
      __typename
      ... on MuteActorPayload {
        mutee {
          id
          viewerMutes(actingAccountId: $actingAccountId)
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

const unmuteActorMutation = graphql`
  mutation ProfileActionMenu_unmuteActor_Mutation(
    $input: UnmuteActorInput!
    $actingAccountId: ID
  ) {
    unmuteActor(input: $input) {
      __typename
      ... on UnmuteActorPayload {
        mutee {
          id
          viewerMutes(actingAccountId: $actingAccountId)
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

const removeFollowerMutation = graphql`
  mutation ProfileActionMenu_removeFollower_Mutation(
    $input: RemoveFollowerInput!
    $actingAccountId: ID
  ) {
    removeFollower(input: $input) {
      __typename
      ... on RemoveFollowerPayload {
        followee {
          id
          followers { totalCount }
        }
        follower {
          id
          followsViewer(actingAccountId: $actingAccountId)
          followees { totalCount }
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

export function ProfileActionMenu(props: ProfileActionMenuProps) {
  const { t } = useLingui();
  const viewer = useViewer();
  const actingAccount = useActingAccount();
  const [showConfirm, setShowConfirm] = createSignal(false);
  const [showRemoveFollowerConfirm, setShowRemoveFollowerConfirm] =
    createSignal(false);
  const [showReport, setShowReport] = createSignal(false);
  const actor = createFragment(
    graphql`
      fragment ProfileActionMenu_actor on Actor
        @argumentDefinitions(actingAccountId: { type: "ID", defaultValue: null })
      {
        id
        username
        handle
        rawName
        local
        iri
        isViewer(actingAccountId: $actingAccountId)
        viewerBlocks(actingAccountId: $actingAccountId)
        blocksViewer(actingAccountId: $actingAccountId)
        viewerMutes(actingAccountId: $actingAccountId)
        followsViewer(actingAccountId: $actingAccountId)
      }
    `,
    () => props.$actor,
  );

  const [blockActor, isBlocking] = createMutation<
    ProfileActionMenu_blockActor_Mutation
  >(blockActorMutation);
  const [unblockActor, isUnblocking] = createMutation<
    ProfileActionMenu_unblockActor_Mutation
  >(unblockActorMutation);
  const [muteActor, isMuting] = createMutation<
    ProfileActionMenu_muteActor_Mutation
  >(muteActorMutation);
  const [unmuteActor, isUnmuting] = createMutation<
    ProfileActionMenu_unmuteActor_Mutation
  >(unmuteActorMutation);
  const [removeFollower, isRemovingFollower] = createMutation<
    ProfileActionMenu_removeFollower_Mutation
  >(removeFollowerMutation);

  const displayName = () => actor()?.rawName ?? actor()?.username ?? "";
  const isPending = () => isBlocking() || isUnblocking();
  const isCurrentViewerActor = () => actor()?.isViewer ?? false;
  const selectedActingAccountInput = () => {
    const actingAccountId = actingAccount.selectedActingAccountId();
    return {
      actingAccountId,
      input: actingAccountId == null ? {} : { actingAccountId },
    };
  };
  const showErrorToast = (title: string) => {
    showToast({
      title,
      variant: "destructive",
    });
  };
  const handleMutationError = (
    typename: string | undefined,
    invalidInputTitle: string,
  ) => {
    if (typename === "NotAuthenticatedError") {
      showErrorToast(t`You must be signed in`);
      return true;
    }
    if (typename === "InvalidInputError") {
      showErrorToast(invalidInputTitle);
      return true;
    }
    return false;
  };
  const handleBlockToggleResult = async (
    typename: string,
    successTypename: "BlockActorPayload" | "UnblockActorPayload",
    invalidInputTitle: string,
    successTitle: string,
  ) => {
    if (handleMutationError(typename, invalidInputTitle)) {
      releaseProfileContentGate();
      return;
    }
    if (typename === successTypename) {
      showToast({ title: successTitle });
      await revalidateProfileContent();
      return;
    }
    releaseProfileContentGate();
  };

  const handleBlockToggle = () => {
    const actorData = actor();
    if (!actorData) return;

    holdProfileContentGate();
    const acting = selectedActingAccountInput();

    if (actorData.viewerBlocks) {
      unblockActor({
        variables: {
          input: { actorId: actorData.id, ...acting.input },
          actingAccountId: acting.actingAccountId ?? null,
        },
        onCompleted(response) {
          void handleBlockToggleResult(
            response.unblockActor.__typename,
            "UnblockActorPayload",
            t`Failed to unblock this user`,
            t`User unblocked`,
          );
        },
        onError() {
          releaseProfileContentGate();
          showErrorToast(t`Failed to unblock this user`);
        },
      });
    } else {
      blockActor({
        variables: {
          input: { actorId: actorData.id, ...acting.input },
          actingAccountId: acting.actingAccountId ?? null,
        },
        onCompleted(response) {
          void handleBlockToggleResult(
            response.blockActor.__typename,
            "BlockActorPayload",
            t`Failed to block this user`,
            t`User blocked`,
          );
        },
        onError() {
          releaseProfileContentGate();
          showErrorToast(t`Failed to block this user`);
        },
      });
    }
  };

  const isMutePending = () => isMuting() || isUnmuting();
  const handleRemoveFollower = () => {
    const actorData = actor();
    if (!actorData) return;
    const acting = selectedActingAccountInput();

    removeFollower({
      variables: {
        input: { actorId: actorData.id, ...acting.input },
        actingAccountId: acting.actingAccountId ?? null,
      },
      onCompleted(response) {
        const typename = response.removeFollower?.__typename;
        if (handleMutationError(typename, t`Failed to remove follower`)) {
          return;
        }
        if (typename === "RemoveFollowerPayload") {
          showToast({ title: t`Follower removed`, variant: "success" });
          return;
        }
        showErrorToast(t`Failed to remove follower`);
      },
      onError() {
        showErrorToast(t`Failed to remove follower`);
      },
    });
  };

  const handleMuteToggle = () => {
    const actorData = actor();
    if (!actorData) return;
    const acting = selectedActingAccountInput();

    if (actorData.viewerMutes) {
      unmuteActor({
        variables: {
          input: { actorId: actorData.id, ...acting.input },
          actingAccountId: acting.actingAccountId ?? null,
        },
        onCompleted(response) {
          const typename = response.unmuteActor?.__typename;
          if (handleMutationError(typename, t`Failed to unmute this user`)) {
            return;
          }
          if (typename === "UnmuteActorPayload") {
            showToast({ title: t`User unmuted` });
          }
        },
        onError() {
          showErrorToast(t`Failed to unmute this user`);
        },
      });
    } else {
      muteActor({
        variables: {
          input: { actorId: actorData.id, ...acting.input },
          actingAccountId: acting.actingAccountId ?? null,
        },
        onCompleted(response) {
          const typename = response.muteActor?.__typename;
          if (handleMutationError(typename, t`Failed to mute this user`)) {
            return;
          }
          if (typename === "MuteActorPayload") {
            showToast({ title: t`User muted` });
          }
        },
        onError() {
          showErrorToast(t`Failed to mute this user`);
        },
      });
    }
  };

  return (
    <Show
      when={actor() && viewer.isLoaded() &&
        viewer.isAuthenticated() && !isCurrentViewerActor()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          as={(triggerProps: Record<string, unknown>) => (
            <Button
              variant="ghost"
              size="sm"
              class="h-9 w-9 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
              aria-label={t`Profile actions`}
              {...triggerProps}
            >
              <IconEllipsis class="size-4" />
            </Button>
          )}
        />
        <DropdownMenuContent class="min-w-40">
          <Show
            when={viewer.moderator() && actor() != null && !actor()!.local}
          >
            <RefreshFromOriginItem uri={actor()!.iri} />
          </Show>
          <DropdownMenuItem
            class="cursor-pointer"
            disabled={isMutePending()}
            onSelect={handleMuteToggle}
          >
            <Show when={actor()?.viewerMutes} fallback={<IconVolumeX />}>
              <IconVolume2 />
            </Show>
            <Show when={actor()?.viewerMutes} fallback={t`Mute`}>
              {t`Unmute`}
            </Show>
          </DropdownMenuItem>
          <Show when={actor()?.followsViewer}>
            <DropdownMenuItem
              class="cursor-pointer text-error-foreground focus:bg-error focus:text-error-foreground"
              disabled={isRemovingFollower()}
              onSelect={() => setShowRemoveFollowerConfirm(true)}
            >
              <IconUserMinus />
              {t`Remove from followers`}
            </DropdownMenuItem>
          </Show>
          <DropdownMenuItem
            classList={{
              "cursor-pointer": true,
              "text-error-foreground": !actor()?.viewerBlocks,
              "focus:bg-error": !actor()?.viewerBlocks,
              "focus:text-error-foreground": !actor()?.viewerBlocks,
            }}
            disabled={isPending()}
            onSelect={() => setShowConfirm(true)}
          >
            <Show when={actor()?.viewerBlocks} fallback={<IconBan />}>
              <IconUndo2 />
            </Show>
            <Show when={actor()?.viewerBlocks} fallback={t`Block`}>
              {t`Unblock`}
            </Show>
          </DropdownMenuItem>
          <DropdownMenuItem
            class="cursor-pointer text-error-foreground focus:bg-error focus:text-error-foreground"
            onSelect={() => setShowReport(true)}
          >
            <IconFlag />
            {t`Report user`}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Show when={actor()}>
        <ReportDialog
          open={showReport()}
          onOpenChange={setShowReport}
          targetId={actor()!.id}
          targetKind="user"
          targetHandle={actor()!.handle}
          targetIsRemote={!actor()!.local}
        />
      </Show>

      <AlertDialog open={showConfirm()} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Show when={actor()?.viewerBlocks} fallback={t`Block user?`}>
                {t`Unblock user?`}
              </Show>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Show
                when={actor()?.viewerBlocks}
                fallback={t`Are you sure you want to block ${displayName()} (${actor()?.handle})? They won't be able to follow you or see your posts.`}
              >
                {t`Are you sure you want to unblock ${displayName()} (${actor()?.handle})? They will be able to follow you and see your posts.`}
              </Show>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose aria-label={t`Cancel`}>
              {t`Cancel`}
            </AlertDialogClose>
            <AlertDialogAction
              aria-label={actor()?.viewerBlocks ? t`Unblock` : t`Block`}
              class={actor()?.viewerBlocks
                ? undefined
                : "bg-destructive text-destructive-foreground hover:bg-destructive/90"}
              onClick={handleBlockToggle}
              disabled={isPending()}
            >
              <Show when={actor()?.viewerBlocks} fallback={t`Block`}>
                {t`Unblock`}
              </Show>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showRemoveFollowerConfirm()}
        onOpenChange={setShowRemoveFollowerConfirm}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Remove follower?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`Are you sure you want to remove ${displayName()} (${actor()?.handle}) from your followers?`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose aria-label={t`Cancel`}>
              {t`Cancel`}
            </AlertDialogClose>
            <AlertDialogAction
              aria-label={t`Remove from followers`}
              class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleRemoveFollower}
              disabled={isRemovingFollower()}
            >
              {t`Remove from followers`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Show>
  );
}
