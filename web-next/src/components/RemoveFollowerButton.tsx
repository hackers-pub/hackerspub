import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import IconUserMinus from "~icons/lucide/user-minus";
import type { RemoveFollowerButton_actor$key } from "./__generated__/RemoveFollowerButton_actor.graphql.ts";
import type { RemoveFollowerButton_removeFollower_Mutation } from "./__generated__/RemoveFollowerButton_removeFollower_Mutation.graphql.ts";
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
import { showToast } from "~/components/ui/toast.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface RemoveFollowerButtonProps {
  $actor: RemoveFollowerButton_actor$key;
  connectionId: string;
}

const removeFollowerMutation = graphql`
  mutation RemoveFollowerButton_removeFollower_Mutation(
    $input: RemoveFollowerInput!
    $connections: [ID!]!
  ) {
    removeFollower(input: $input) {
      __typename
      ... on RemoveFollowerPayload {
        followee {
          id
          followers { totalCount }
        }
        follower {
          id @deleteEdge(connections: $connections)
          followees { totalCount }
          followsViewer
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

export function RemoveFollowerButton(props: RemoveFollowerButtonProps) {
  const { t } = useLingui();
  const [showConfirm, setShowConfirm] = createSignal(false);
  const actor = createFragment(
    graphql`
      fragment RemoveFollowerButton_actor on Actor {
        id
        username
        handle
        rawName
      }
    `,
    () => props.$actor,
  );
  const [removeFollower, isRemoving] = createMutation<
    RemoveFollowerButton_removeFollower_Mutation
  >(removeFollowerMutation);

  const displayName = () => actor()?.rawName ?? actor()?.username ?? "";
  const label = () => t`Remove from followers`;

  function handleRemove() {
    const actorData = actor();
    if (actorData == null) return;

    removeFollower({
      variables: {
        input: { actorId: actorData.id },
        connections: [props.connectionId],
      },
      onCompleted(response) {
        switch (response.removeFollower.__typename) {
          case "RemoveFollowerPayload":
            showToast({ title: t`Follower removed`, variant: "success" });
            break;
          case "NotAuthenticatedError":
            showToast({
              title: t`You must be signed in`,
              variant: "destructive",
            });
            break;
          default:
            showToast({
              title: t`Failed to remove follower`,
              variant: "destructive",
            });
        }
      },
      onError() {
        showToast({
          title: t`Failed to remove follower`,
          variant: "destructive",
        });
      },
    });
  }

  return (
    <Show keyed when={actor()}>
      {(actor) => (
        <>
          <Tooltip>
            <TooltipTrigger
              as={Button}
              variant="ghost"
              size="sm"
              class="h-9 w-9 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={label()}
              disabled={isRemoving()}
              onClick={() => setShowConfirm(true)}
            >
              <IconUserMinus class="size-4" />
            </TooltipTrigger>
            <TooltipContent>{label()}</TooltipContent>
          </Tooltip>

          <AlertDialog open={showConfirm()} onOpenChange={setShowConfirm}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t`Remove follower?`}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t`Are you sure you want to remove ${displayName()} (${actor.handle}) from your followers?`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose>{t`Cancel`}</AlertDialogClose>
                <AlertDialogAction
                  class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={isRemoving()}
                  onClick={handleRemove}
                >
                  {label()}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </Show>
  );
}
