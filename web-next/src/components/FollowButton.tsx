import { ConnectionHandler, graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { FollowButton_actor$key } from "./__generated__/FollowButton_actor.graphql.ts";
import type { FollowButton_followActor_Mutation } from "./__generated__/FollowButton_followActor_Mutation.graphql.ts";
import type { FollowButton_unfollowActor_Mutation } from "./__generated__/FollowButton_unfollowActor_Mutation.graphql.ts";
import { RemoteFollowButton } from "./RemoteFollowButton.tsx";

export interface FollowButtonProps {
  $actor: FollowButton_actor$key;
  onFollowed?: () => void;
}

const followActorMutation = graphql`
  mutation FollowButton_followActor_Mutation(
    $input: FollowActorInput!
    $actingAccountId: ID
    $connections: [ID!]!
  ) {
    followActor(input: $input) {
      __typename
      ... on FollowActorPayload {
        followee {
          id
          viewerFollows(actingAccountId: $actingAccountId)
          viewerFollowState(actingAccountId: $actingAccountId)
          followsViewer(actingAccountId: $actingAccountId)
          followers {
            totalCount
          }
        }
        follower
          @appendNode(
            connections: $connections
            edgeTypeName: "ActorFollowersConnectionEdge"
          ) {
          id
          followees {
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

const unfollowActorMutation = graphql`
  mutation FollowButton_unfollowActor_Mutation(
    $input: UnfollowActorInput!
    $actingAccountId: ID
    $connections: [ID!]!
  ) {
    unfollowActor(input: $input) {
      __typename
      ... on UnfollowActorPayload {
        followee {
          id
          viewerFollows(actingAccountId: $actingAccountId)
          viewerFollowState(actingAccountId: $actingAccountId)
          followsViewer(actingAccountId: $actingAccountId)
          followers {
            totalCount
          }
        }
        follower {
          id @deleteEdge(connections: $connections)
          followees {
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

export function FollowButton(props: FollowButtonProps) {
  const { t } = useLingui();
  const viewer = useViewer();
  const actingAccount = useActingAccount();
  const actor = createFragment(
    graphql`
      fragment FollowButton_actor on Actor
      @argumentDefinitions(
        actingAccountId: { type: "ID", defaultValue: null }
      ) {
        id
        username
        handle
        rawName
        local
        isViewer(actingAccountId: $actingAccountId)
        viewerFollows(actingAccountId: $actingAccountId)
        viewerFollowState(actingAccountId: $actingAccountId)
        viewerBlocks(actingAccountId: $actingAccountId)
        blocksViewer(actingAccountId: $actingAccountId)
        followsViewer(actingAccountId: $actingAccountId)
        successor {
          id
        }
      }
    `,
    () => props.$actor,
  );

  const [followActor, followPending] =
    createMutation<FollowButton_followActor_Mutation>(followActorMutation);

  const [unfollowActor, unfollowPending] =
    createMutation<FollowButton_unfollowActor_Mutation>(unfollowActorMutation);

  const isCurrentViewerActor = () => actor()?.isViewer ?? false;
  const mutationPending = () => followPending() || unfollowPending();
  const canStartFollowing = () => actor()?.successor == null;

  const handleClick = () => {
    const actorData = actor();
    if (!actorData || mutationPending()) return;

    const connectionId = ConnectionHandler.getConnectionID(
      actorData.id,
      "ActorFollowerList_followers",
    );
    const actingAccountId = actingAccount.selectedActingAccountId();

    const input = {
      actorId: actorData.id,
      ...(actingAccountId == null ? {} : { actingAccountId }),
    };
    const actingAccountVariable = actingAccountId ?? null;

    if (actorData.viewerFollowState !== "NONE") {
      const variables = {
        input: {
          ...input,
        },
        actingAccountId: actingAccountVariable,
        connections:
          actorData.viewerFollowState === "PENDING" ? [] : [connectionId],
      };

      unfollowActor({
        variables,
        onCompleted(response) {
          if (response.unfollowActor.__typename === "NotAuthenticatedError") {
            showToast({
              title: t`You must be signed in`,
              variant: "destructive",
            });
          }
        },
        onError() {
          showToast({
            title: t`Failed to unfollow`,
            variant: "destructive",
          });
        },
      });
    } else {
      const variables = {
        input: {
          ...input,
        },
        actingAccountId: actingAccountVariable,
        connections: actorData.local ? [connectionId] : [],
      };

      followActor({
        variables,
        onCompleted(response) {
          if (response.followActor.__typename === "NotAuthenticatedError") {
            showToast({
              title: t`You must be signed in`,
              variant: "destructive",
            });
          } else if (response.followActor.__typename === "FollowActorPayload") {
            props.onFollowed?.();
          }
        },
        onError() {
          showToast({
            title: t`Failed to follow`,
            variant: "destructive",
          });
        },
      });
    }
  };

  return (
    <Show keyed when={actor()}>
      {(actor) => (
        <Show
          when={
            !isCurrentViewerActor() &&
            !actor.viewerBlocks &&
            !actor.blocksViewer &&
            viewer.isLoaded()
          }
        >
          <Show when={viewer.isAuthenticated() || canStartFollowing()}>
            <Show
              when={viewer.isAuthenticated()}
              fallback={
                <RemoteFollowButton
                  actorId={actor.id}
                  actorHandle={actor.handle}
                  actorName={actor.rawName}
                />
              }
            >
              <Show
                when={actor.viewerFollowState !== "NONE" || canStartFollowing()}
              >
                <Button
                  variant={
                    actor.viewerFollowState === "NONE" ? "default" : "outline"
                  }
                  size="sm"
                  class="cursor-pointer"
                  disabled={mutationPending()}
                  onClick={handleClick}
                >
                  {actor.viewerFollowState === "PENDING"
                    ? t`Cancel request`
                    : actor.viewerFollowState === "ACCEPTED"
                      ? t`Unfollow`
                      : actor.followsViewer
                        ? t`Follow back`
                        : t`Follow`}
                </Button>
              </Show>
            </Show>
          </Show>
        </Show>
      )}
    </Show>
  );
}
