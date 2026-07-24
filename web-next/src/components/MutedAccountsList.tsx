import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createMutation, createPaginationFragment } from "solid-relay";
import { AccountListBase } from "./AccountListBase.tsx";
import type { MutedAccountsList_actor$key } from "./__generated__/MutedAccountsList_actor.graphql.ts";
import type { MutedAccountsList_unmuteActor_Mutation } from "./__generated__/MutedAccountsList_unmuteActor_Mutation.graphql.ts";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";

export interface MutedAccountsListProps {
  $actor: MutedAccountsList_actor$key;
}

const PAGE_SIZE = 20 as const;

const unmuteActorMutation = graphql`
  mutation MutedAccountsList_unmuteActor_Mutation(
    $input: UnmuteActorInput!
    $connections: [ID!]!
  ) {
    unmuteActor(input: $input) {
      __typename
      ... on UnmuteActorPayload {
        mutee {
          id @deleteEdge(connections: $connections)
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

export function MutedAccountsList(props: MutedAccountsListProps) {
  const { t } = useLingui();
  const muted = createPaginationFragment(
    graphql`
      fragment MutedAccountsList_actor on Actor
      @refetchable(queryName: "MutedAccountsListQuery")
      @argumentDefinitions(
        cursor: { type: "String" }
        count: { type: "Int", defaultValue: 20 }
      ) {
        mutedActors(after: $cursor, first: $count)
          @connection(key: "MutedAccountsList_mutedActors") {
          __id
          edges {
            __id
            node {
              id
              avatarUrl
              name
              handle
              local
              username
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$actor,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");
  const [unmuteActor, unmuting] =
    createMutation<MutedAccountsList_unmuteActor_Mutation>(unmuteActorMutation);

  function onLoadMore() {
    setLoadingState("loading");
    muted.loadNext(PAGE_SIZE, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  function onUnmute(actorId: string, connectionId: string) {
    unmuteActor({
      variables: { input: { actorId }, connections: [connectionId] },
      onCompleted(response) {
        if (response.unmuteActor?.__typename === "UnmuteActorPayload") {
          showToast({ title: t`User unmuted`, variant: "success" });
        } else {
          showToast({ title: t`Failed to unmute this user`, variant: "error" });
        }
      },
      onError() {
        showToast({ title: t`Failed to unmute this user`, variant: "error" });
      },
    });
  }

  return (
    <Show keyed when={muted()}>
      {(data) => (
        <AccountListBase
          edges={data.mutedActors.edges}
          hasNext={muted.hasNext}
          pending={muted.pending}
          loadingState={loadingState()}
          onLoadMore={onLoadMore}
          onAction={(actorId) => onUnmute(actorId, data.mutedActors.__id)}
          actionLabel={t`Unmute`}
          actionDisabled={unmuting()}
          emptyMessage={t`You haven't muted anyone.`}
        />
      )}
    </Show>
  );
}
