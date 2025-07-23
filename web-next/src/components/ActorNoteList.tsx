import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createPaginationFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { ActorNoteList_notes$key } from "./__generated__/ActorNoteList_notes.graphql.ts";
import { NoteCard } from "./NoteCard.tsx";

export interface ActorNoteListProps {
  $notes: ActorNoteList_notes$key;
}

export function ActorNoteList(props: ActorNoteListProps) {
  const { t } = useLingui();
  const notes = createPaginationFragment(
    graphql`
      fragment ActorNoteList_notes on Actor
        @refetchable(queryName: "ActorNoteListQuery")
        @argumentDefinitions(
          cursor: { type: "String" }
          count: { type: "Int", defaultValue: 20 }
        )
      {
        notes(after: $cursor, first: $count)
          @connection(key: "ActorNoteList_notes")
        {
          edges {
            node {
              ...NoteCard_note
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    () => props.$notes,
  );
  const [loadingState, setLoadingState] = createSignal<
    "loaded" | "loading" | "errored"
  >("loaded");

  function onLoadMore() {
    setLoadingState("loading");
    notes.loadNext(20, {
      onComplete(error) {
        setLoadingState(error == null ? "loaded" : "errored");
      },
    });
  }

  return (
    <div class="border rounded-xl *:first:rounded-t-xl *:last:rounded-b-xl max-w-prose mx-auto my-4">
      <Show when={notes()}>
        {(data) => (
          <>
            <For each={data().notes.edges}>
              {(edge) => <NoteCard $note={edge.node} />}
            </For>
            <Show when={notes.hasNext}>
              <div
                on:click={loadingState() === "loading" ? undefined : onLoadMore}
                class="block px-4 py-8 text-center text-muted-foreground cursor-pointer hover:text-primary hover:bg-secondary"
              >
                <Switch>
                  <Match when={notes.pending || loadingState() === "loading"}>
                    {t`Loading more notes…`}
                  </Match>
                  <Match when={loadingState() === "errored"}>
                    {t`Failed to load more notes; click to retry`}
                  </Match>
                  <Match when={loadingState() === "loaded"}>
                    {t`Load more notes`}
                  </Match>
                </Switch>
              </div>
            </Show>
            <Show when={data().notes.edges.length < 1}>
              <div class="px-4 py-8 text-center text-muted-foreground">
                {t`No notes found`}
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
