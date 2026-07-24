import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { ActorSharer, ActorSharerActor } from "./ActorSharer.tsx";
import { MutedReplyPlaceholder } from "./MutedReplyPlaceholder.tsx";
import { NoteCardInternal } from "./NoteCardInternal.tsx";
import { PostSharer } from "./PostSharer.tsx";
import { NoteCard_note$key } from "./__generated__/NoteCard_note.graphql.ts";

export interface NoteCardProps {
  $note: NoteCard_note$key;
  sharerActor?: ActorSharerActor | null;
  sharerTimestamp?: string | null;
  connections?: string[];
  bookmarkListConnections?: string[];
  pinConnections?: string[];
  deferHeavySections?: boolean;
  onDeleted?: () => void;
  /**
   * When true, render a {@link MutedReplyPlaceholder} (with a reveal toggle)
   * instead of the note when its author is muted. Used in reply lists; feeds
   * already exclude muted authors server-side and profiles must stay visible,
   * so they leave this off.
   */
  placeholderIfMuted?: boolean;
}

export function NoteCard(props: NoteCardProps) {
  const note = createFragment(
    graphql`
      fragment NoteCard_note on Note
      @argumentDefinitions(
        actingAccountId: { type: "ID", defaultValue: null }
      ) {
        ...NoteCardInternal_note @arguments(actingAccountId: $actingAccountId)
        ...PostSharer_post
        actor {
          handle
          viewerMutes(actingAccountId: $actingAccountId)
        }
        sharedPost(actingAccountId: $actingAccountId) {
          ...NoteCardInternal_note @arguments(actingAccountId: $actingAccountId)
          actor {
            handle
            viewerMutes(actingAccountId: $actingAccountId)
          }
        }
      }
    `,
    () => props.$note,
  );
  const [revealed, setRevealed] = createSignal(false);
  return (
    <Show keyed when={note()}>
      {(note) => {
        const displayPost = () => note.sharedPost ?? note;
        const mutedActor = () =>
          props.placeholderIfMuted &&
          !revealed() &&
          displayPost().actor?.viewerMutes
            ? displayPost().actor
            : null;
        return (
          <Show
            when={mutedActor()}
            fallback={
              <article class="border-b px-4 py-4 transition-colors hover:bg-muted/30 last:border-none">
                <div class="flex flex-col gap-0.5">
                  <Show when={note.sharedPost}>
                    <PostSharer $post={note} class="ml-14" />
                  </Show>
                  <Show when={props.sharerActor}>
                    <ActorSharer
                      actor={props.sharerActor!}
                      timestamp={props.sharerTimestamp!}
                      class="ml-14"
                    />
                  </Show>
                  <NoteCardInternal
                    $note={displayPost()}
                    connections={props.connections}
                    bookmarkListConnections={props.bookmarkListConnections}
                    pinConnections={props.pinConnections}
                    deferHeavySections={props.deferHeavySections}
                    onDeleted={props.onDeleted}
                  />
                </div>
              </article>
            }
          >
            {(actor) => (
              <article class="border-b last:border-none">
                <MutedReplyPlaceholder
                  handle={actor().handle}
                  onReveal={() => setRevealed(true)}
                />
              </article>
            )}
          </Show>
        );
      }}
    </Show>
  );
}
