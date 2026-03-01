import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NoteCard_note$key } from "./__generated__/NoteCard_note.graphql.ts";
import { NoteCardInternal } from "./NoteCardInternal.tsx";
import { PostSharer } from "./PostSharer.tsx";

export interface NoteCardProps {
  $note: NoteCard_note$key;
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
    <Show when={note()}>
      {(note) => {
        const displayPost = () => note().sharedPost ?? note();
        return (
          <article class="px-4 py-2 border-b-1">
            <div class="flex flex-col gap-0.5">
              <Show when={note().sharedPost}>
                <PostSharer $post={note()} class="ml-14" />
              </Show>
              <NoteCardInternal
                $note={displayPost()}
                onDeleted={props.onDeleted}
              />
            </div>
          </article>
        );
      }}
    </Show>
  );
}
