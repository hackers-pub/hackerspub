import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createMutation, createPaginationFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { BlockedAccountsList_actor$key } from "./__generated__/BlockedAccountsList_actor.graphql.ts";
import type { BlockedAccountsList_unblockActor_Mutation } from "./__generated__/BlockedAccountsList_unblockActor_Mutation.graphql.ts";
import { ActorHoverCard } from "./ActorHoverCard.tsx";

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
        if (response.unblockActor.__typename === "UnblockActorPayload") {
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
        <Show
          when={data.blockedActors.edges.length > 0}
          fallback={
            <p class="px-4 py-8 text-center text-muted-foreground">
              {t`You haven't blocked anyone.`}
            </p>
          }
        >
          <ul class="divide-y divide-solid">
            <For each={data.blockedActors.edges}>
              {(edge) => (
                <li class="flex items-center gap-3 px-4 py-3">
                  <ActorHoverCard handle={edge.node.handle} class="shrink-0">
                    <Avatar class="size-10 shrink-0">
                      <a
                        href={`/${
                          edge.node.local
                            ? `@${edge.node.username}`
                            : edge.node.handle
                        }`}
                      >
                        <AvatarImage
                          src={edge.node.avatarUrl}
                          class="size-10"
                        />
                      </a>
                    </Avatar>
                  </ActorHoverCard>
                  <div class="flex min-w-0 grow flex-col">
                    <Show
                      when={(edge.node.name ?? "").trim() !== ""}
                      fallback={
                        <a
                          href={`/${
                            edge.node.local
                              ? `@${edge.node.username}`
                              : edge.node.handle
                          }`}
                          class="truncate font-semibold"
                        >
                          {edge.node.username}
                        </a>
                      }
                    >
                      <a
                        href={`/${
                          edge.node.local
                            ? `@${edge.node.username}`
                            : edge.node.handle
                        }`}
                        innerHTML={edge.node.name ?? ""}
                        class="truncate font-semibold"
                      />
                    </Show>
                    <span
                      class="truncate text-sm text-muted-foreground select-all"
                      title={edge.node.handle}
                    >
                      {edge.node.handle}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    class="shrink-0 cursor-pointer"
                    disabled={isUnblocking()}
                    onClick={() =>
                      onUnblock(edge.node.id, data.blockedActors.__id)}
                  >
                    {t`Unblock`}
                  </Button>
                </li>
              )}
            </For>
          </ul>
          <Show when={blocked.hasNext}>
            <button
              type="button"
              on:click={loadingState() === "loading" ? undefined : onLoadMore}
              disabled={blocked.pending || loadingState() === "loading"}
              class="block w-full cursor-pointer px-4 py-6 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Switch>
                <Match when={blocked.pending || loadingState() === "loading"}>
                  {t`Loading more…`}
                </Match>
                <Match when={loadingState() === "errored"}>
                  {t`Failed to load more; click to retry`}
                </Match>
                <Match when={loadingState() === "loaded"}>
                  {t`Load more`}
                </Match>
              </Switch>
            </button>
          </Show>
        </Show>
      )}
    </Show>
  );
}
