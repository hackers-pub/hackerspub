import { graphql } from "relay-runtime";
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
  mutation FollowButton_followActor_Mutation($input: FollowActorInput!) {
    followActor(input: $input) {
      ... on FollowActorPayload {
        actor {
          id
          viewerFollows
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
  mutation FollowButton_unfollowActor_Mutation($input: UnfollowActorInput!) {
    unfollowActor(input: $input) {
      ... on UnfollowActorPayload {
        actor {
          id
          viewerFollows
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
        username
        viewerFollows
        followsViewer
        account {
          __typename
        }
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

    if (actorData.viewerFollows) {
      unfollowActor({
        variables: {
          input: { actorId: actorData.id },
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
        variables: {
          input: { actorId: actorData.id },
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
        <Show when={actor().account == null}>
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
