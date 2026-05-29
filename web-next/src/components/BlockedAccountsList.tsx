import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createMutation, createPaginationFragment } from "solid-relay";
import { AccountListBase } from "./AccountListBase.tsx";
import type { BlockedAccountsList_actor$key } from "./__generated__/BlockedAccountsList_actor.graphql.ts";
import type { BlockedAccountsList_unblockActor_Mutation } from "./__generated__/BlockedAccountsList_unblockActor_Mutation.graphql.ts";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export interface BlockedAccountsListProps {
  $actor: BlockedAccountsList_actor$key;
}

const PAGE_SIZE = 20 as const;

const unblockActorMutation = graphql`
  mutation BlockedAccountsList_unblockActor_Mutation(
    $input: UnblockActorInput!
    $connections: [ID!]!
  ) {
    unblockActor(input: $input) {
      __typename
      ... on UnblockActorPayload {
        blockee {
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

export function BlockedAccountsList(props: BlockedAccountsListProps) {
  const { t } = useLingui();
  const blocked = createPaginationFragment(
    graphql`
      fragment BlockedAccountsList_actor on Actor
        @refetchable(queryName: "BlockedAccountsListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        blockedActors(after: $cursor, first: $count)
          @connection(key: "BlockedAccountsList_blockedActors")
        {
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
  const [unblockActor, isUnblocking] = createMutation<
    BlockedAccountsList_unblockActor_Mutation
  >(unblockActorMutation);

  function onLoadMore() {
    setLoadingState("loading");
    blocked.loadNext(PAGE_SIZE, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  function onUnblock(actorId: string, connectionId: string) {
    unblockActor({
      variables: { input: { actorId }, connections: [connectionId] },
      onCompleted(response) {
        if (response.unblockActor?.__typename === "UnblockActorPayload") {
          showToast({ title: t`User unblocked`, variant: "success" });
        } else {
          showToast({
            title: t`Failed to unblock this user`,
            variant: "error",
          });
        }
      },
      onError() {
        showToast({ title: t`Failed to unblock this user`, variant: "error" });
      },
    });
  }

  return (
    <Show keyed when={blocked()}>
      {(data) => (
        <AccountListBase
          edges={data.blockedActors.edges}
          hasNext={blocked.hasNext}
          pending={blocked.pending}
          loadingState={loadingState()}
          onLoadMore={onLoadMore}
          onAction={(actorId) => onUnblock(actorId, data.blockedActors.__id)}
          actionLabel={t`Unblock`}
          actionDisabled={isUnblocking()}
          emptyMessage={t`You haven't blocked anyone.`}
        />
      )}
    </Show>
  );
}
