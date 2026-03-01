import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NoteCardInternal_note$key } from "./__generated__/NoteCardInternal_note.graphql.ts";
import { LinkPreview } from "./LinkPreview.tsx";
import { NoteHeader } from "./NoteHeader.tsx";
import { NoteMedia } from "./NoteMedia.tsx";
import { PostAvatar } from "./PostAvatar.tsx";
import { PostControls } from "./PostControls.tsx";
import { QuotedPostCard } from "./QuotedPostCard.tsx";

export interface NoteCardInternalProps {
  $note: NoteCardInternal_note$key;
  connections?: string[];
  onDeleted?: () => void;
}

export function NoteCardInternal(props: NoteCardInternalProps) {
  const note = createFragment(
    graphql`
      fragment NoteCardInternal_note on Note {
        __id
        uuid
        content
        language
        actor {
          ...PostAvatar_actor
        }
        ...PostControls_note
        ...NoteMedia_note
        ...LinkPreview_note
        ...NoteHeader_note
        quotedPost {
          ...QuotedPostCard_post
        }
      }
    `,
    () => props.$note,
  );

  return (
    <Show when={note()}>
      {(n) => (
        <div class="flex gap-4">
          <PostAvatar $actor={n().actor} />
          <div class="grow">
            <NoteHeader
              $note={n()}
              connections={props.connections}
              onDeleted={props.onDeleted}
            />
            <div
              innerHTML={n().content}
              lang={n().language ?? undefined}
              class="prose dark:prose-invert break-words overflow-wrap"
            />
            <NoteMedia $note={n()} />
            <LinkPreview $note={n()} />
            <Show when={n().quotedPost}>
              {(quotedPost) => <QuotedPostCard $post={quotedPost()} />}
            </Show>
            <PostControls $note={n()} />
          </div>
        </div>
      )}
    </Show>
  );
}
