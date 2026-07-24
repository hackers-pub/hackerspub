import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createMutation } from "solid-relay";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { HashtagActionBar_followHashtag_Mutation } from "./__generated__/HashtagActionBar_followHashtag_Mutation.graphql.ts";
import type { HashtagActionBar_pinHashtag_Mutation } from "./__generated__/HashtagActionBar_pinHashtag_Mutation.graphql.ts";
import type { HashtagActionBar_unfollowHashtag_Mutation } from "./__generated__/HashtagActionBar_unfollowHashtag_Mutation.graphql.ts";
import type { HashtagActionBar_unpinHashtag_Mutation } from "./__generated__/HashtagActionBar_unpinHashtag_Mutation.graphql.ts";

export interface HashtagActionBarProps {
  tag: string;
  followsHashtag: boolean;
  pinnedHashtags: readonly string[];
}

const followHashtagMutation = graphql`
  mutation HashtagActionBar_followHashtag_Mutation(
    $input: FollowHashtagInput!
    $tag: String!
  ) {
    followHashtag(input: $input) {
      __typename
      ... on FollowHashtagPayload {
        tag
        viewer {
          id
          followsHashtag(tag: $tag)
          pinnedHashtags
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

const unfollowHashtagMutation = graphql`
  mutation HashtagActionBar_unfollowHashtag_Mutation(
    $input: UnfollowHashtagInput!
    $tag: String!
  ) {
    unfollowHashtag(input: $input) {
      __typename
      ... on UnfollowHashtagPayload {
        tag
        viewer {
          id
          followsHashtag(tag: $tag)
          pinnedHashtags
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

const pinHashtagMutation = graphql`
  mutation HashtagActionBar_pinHashtag_Mutation(
    $input: PinHashtagInput!
    $tag: String!
  ) {
    pinHashtag(input: $input) {
      __typename
      ... on PinHashtagPayload {
        tag
        viewer {
          id
          followsHashtag(tag: $tag)
          pinnedHashtags
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

const unpinHashtagMutation = graphql`
  mutation HashtagActionBar_unpinHashtag_Mutation(
    $input: UnpinHashtagInput!
    $tag: String!
  ) {
    unpinHashtag(input: $input) {
      __typename
      ... on UnpinHashtagPayload {
        tag
        viewer {
          id
          followsHashtag(tag: $tag)
          pinnedHashtags
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

export function HashtagActionBar(props: HashtagActionBarProps) {
  const { t } = useLingui();

  const [commitFollow, followInFlight] =
    createMutation<HashtagActionBar_followHashtag_Mutation>(
      followHashtagMutation,
    );
  const [commitUnfollow, unfollowInFlight] =
    createMutation<HashtagActionBar_unfollowHashtag_Mutation>(
      unfollowHashtagMutation,
    );
  const [commitPin, pinInFlight] =
    createMutation<HashtagActionBar_pinHashtag_Mutation>(pinHashtagMutation);
  const [commitUnpin, unpinInFlight] =
    createMutation<HashtagActionBar_unpinHashtag_Mutation>(
      unpinHashtagMutation,
    );

  const isPinned = () => props.pinnedHashtags.includes(props.tag);

  const handleFollow = () => {
    commitFollow({
      variables: { input: { tag: props.tag }, tag: props.tag },
      onCompleted(response) {
        if (response.followHashtag.__typename === "NotAuthenticatedError") {
          showToast({
            title: t`You must be signed in`,
            variant: "destructive",
          });
        } else if (
          response.followHashtag.__typename !== "FollowHashtagPayload"
        ) {
          showToast({ title: t`Failed to follow`, variant: "destructive" });
        }
      },
      onError() {
        showToast({ title: t`Failed to follow`, variant: "destructive" });
      },
    });
  };

  const handleUnfollow = () => {
    commitUnfollow({
      variables: { input: { tag: props.tag }, tag: props.tag },
      onCompleted(response) {
        if (response.unfollowHashtag.__typename === "NotAuthenticatedError") {
          showToast({
            title: t`You must be signed in`,
            variant: "destructive",
          });
        } else if (
          response.unfollowHashtag.__typename !== "UnfollowHashtagPayload"
        ) {
          showToast({ title: t`Failed to unfollow`, variant: "destructive" });
        }
      },
      onError() {
        showToast({ title: t`Failed to unfollow`, variant: "destructive" });
      },
    });
  };

  const handlePin = () => {
    commitPin({
      variables: { input: { tag: props.tag }, tag: props.tag },
      onCompleted(response) {
        if (response.pinHashtag.__typename !== "PinHashtagPayload") {
          showToast({
            title: t`Failed to add to sidebar`,
            variant: "destructive",
          });
        }
      },
      onError() {
        showToast({
          title: t`Failed to add to sidebar`,
          variant: "destructive",
        });
      },
    });
  };

  const handleUnpin = () => {
    commitUnpin({
      variables: { input: { tag: props.tag }, tag: props.tag },
      onCompleted(response) {
        if (response.unpinHashtag.__typename !== "UnpinHashtagPayload") {
          showToast({
            title: t`Failed to remove from sidebar`,
            variant: "destructive",
          });
        }
      },
      onError() {
        showToast({
          title: t`Failed to remove from sidebar`,
          variant: "destructive",
        });
      },
    });
  };

  return (
    <div class="flex gap-2">
      <Show
        when={props.followsHashtag}
        fallback={
          <Button
            variant="default"
            size="sm"
            disabled={followInFlight()}
            onClick={handleFollow}
          >
            {t`Follow`}
          </Button>
        }
      >
        <Button
          variant="outline"
          size="sm"
          disabled={unfollowInFlight()}
          onClick={handleUnfollow}
        >
          {t`Unfollow`}
        </Button>
        <Show
          when={isPinned()}
          fallback={
            <Button
              variant="ghost"
              size="sm"
              disabled={pinInFlight()}
              onClick={handlePin}
            >
              {t`Add to sidebar`}
            </Button>
          }
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={unpinInFlight()}
            onClick={handleUnpin}
          >
            {t`Remove from sidebar`}
          </Button>
        </Show>
      </Show>
    </div>
  );
}
