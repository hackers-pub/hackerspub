import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createMutation, createPaginationFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { Button } from "~/components/ui/button.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { MutedAccountsList_actor$key } from "./__generated__/MutedAccountsList_actor.graphql.ts";
import type { MutedAccountsList_unmuteActor_Mutation } from "./__generated__/MutedAccountsList_unmuteActor_Mutation.graphql.ts";
import { ActorHoverCard } from "./ActorHoverCard.tsx";

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
        )
      {
        mutedActors(after: $cursor, first: $count)
          @connection(key: "MutedAccountsList_mutedActors")
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
  const [unmuteActor, isUnmuting] = createMutation<
    MutedAccountsList_unmuteActor_Mutation
  >(unmuteActorMutation);

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
        if (response.unmuteActor.__typename === "UnmuteActorPayload") {
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
        <Show
          when={data.mutedActors.edges.length > 0}
          fallback={
            <p class="px-4 py-8 text-center text-muted-foreground">
              {t`You haven't muted anyone.`}
            </p>
          }
        >
          <ul class="divide-y divide-solid">
            <For each={data.mutedActors.edges}>
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
                    <a
                      href={`/${
                        edge.node.local
                          ? `@${edge.node.username}`
                          : edge.node.handle
                      }`}
                      innerHTML={edge.node.name ?? edge.node.username}
                      class="truncate font-semibold"
                    />
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
                    disabled={isUnmuting()}
                    onClick={() =>
                      onUnmute(edge.node.id, data.mutedActors.__id)}
                  >
                    {t`Unmute`}
                  </Button>
                </li>
              )}
            </For>
          </ul>
          <Show when={muted.hasNext}>
            <button
              type="button"
              on:click={loadingState() === "loading" ? undefined : onLoadMore}
              disabled={muted.pending || loadingState() === "loading"}
              class="block w-full cursor-pointer px-4 py-6 text-center text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Switch>
                <Match when={muted.pending || loadingState() === "loading"}>
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
