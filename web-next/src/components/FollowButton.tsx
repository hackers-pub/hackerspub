import { ConnectionHandler, graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment, createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { FollowButton_actor$key } from "./__generated__/FollowButton_actor.graphql.ts";
import type { FollowButton_followActor_Mutation } from "./__generated__/FollowButton_followActor_Mutation.graphql.ts";
import type { FollowButton_unfollowActor_Mutation } from "./__generated__/FollowButton_unfollowActor_Mutation.graphql.ts";

export interface FollowButtonProps {
  $actor: FollowButton_actor$key;
}

const followActorMutation = graphql`
  mutation FollowButton_followActor_Mutation(
    $input: FollowActorInput!
    $connections: [ID!]!
  ) {
    followActor(input: $input) {
      __typename
      ... on FollowActorPayload {
        followee {
          id
          viewerFollows
          followers { totalCount }
        }
        follower @appendNode(
          connections: $connections
          edgeTypeName: "ActorFollowersConnectionEdge"
        ) {
          id
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

const unfollowActorMutation = graphql`
  mutation FollowButton_unfollowActor_Mutation(
    $input: UnfollowActorInput!
    $connections: [ID!]!
  ) {
    unfollowActor(input: $input) {
      __typename
      ... on UnfollowActorPayload {
        followee {
          id
          viewerFollows
          followers { totalCount }
        }
        follower {
            id @deleteEdge(connections: $connections)
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

export function FollowButton(props: FollowButtonProps) {
  const { t } = useLingui();
  const actor = createFragment(
    graphql`
      fragment FollowButton_actor on Actor {
        id
        isViewer
        viewerFollows
        followsViewer
      }
    `,
    () => props.$actor,
  );

  const [followActor] = createMutation<FollowButton_followActor_Mutation>(
    followActorMutation,
  );

  const [unfollowActor] = createMutation<FollowButton_unfollowActor_Mutation>(
    unfollowActorMutation,
  );

  const handleClick = () => {
    const actorData = actor();
    if (!actorData) return;

    const connectionId = ConnectionHandler.getConnectionID(
      actorData.id,
      "ActorFollowerList_followers",
    );

    const variables = {
      input: { actorId: actorData.id },
      connections: [connectionId],
    };

    if (actorData.viewerFollows) {
      unfollowActor({
        variables,
        onCompleted(response) {
          if (
            response.unfollowActor.__typename === "NotAuthenticatedError"
          ) {
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
      followActor({
        variables,
        onCompleted(response) {
          if (response.followActor.__typename === "NotAuthenticatedError") {
            showToast({
              title: t`You must be signed in`,
              variant: "destructive",
            });
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
    <Show when={actor()}>
      {(actor) => (
        <Show when={!actor().isViewer}>
          <Button
            variant={actor().viewerFollows ? "outline" : "default"}
            size="sm"
            class="cursor-pointer"
            onClick={handleClick}
          >
            {actor().viewerFollows
              ? t`Unfollow`
              : actor().followsViewer
              ? t`Follow Back`
              : t`Follow`}
          </Button>
        </Show>
      )}
    </Show>
  );
}
