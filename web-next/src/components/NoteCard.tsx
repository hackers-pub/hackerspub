import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { ActorSharer, ActorSharerActor } from "./ActorSharer.tsx";
import { NoteCard_note$key } from "./__generated__/NoteCard_note.graphql.ts";
import { NoteCardInternal } from "./NoteCardInternal.tsx";
import { PostSharer } from "./PostSharer.tsx";

export interface NoteCardProps {
  $note: NoteCard_note$key;
  sharerActor?: ActorSharerActor | null;
  sharerTimestamp?: string | null;
  connections?: string[];
  bookmarkListConnections?: string[];
  pinConnections?: string[];
  deferHeavySections?: boolean;
  onDeleted?: () => void;
}

export function NoteCard(props: NoteCardProps) {
  const note = createFragment(
    graphql`
      fragment NoteCard_note on Note {
        ...NoteCardInternal_note
        ...PostSharer_post
        sharedPost {
          ...NoteCardInternal_note
        }
      }
    `,
    () => props.$note,
  );
  return (
    <Show keyed when={note()}>
      {(note) => {
        const displayPost = () => note.sharedPost ?? note;
        return (
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
        );
      }}
    </Show>
  );
}
