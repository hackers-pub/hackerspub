import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment } from "solid-relay";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
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
  bookmarkListConnections?: string[];
  pinConnections?: string[];
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
        ...PostControls_post
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

  const [proseRef, setProseRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(proseRef);

  return (
    <Show keyed when={note()}>
      {(n) => (
        <div class="flex gap-3 sm:gap-4">
          <PostAvatar $actor={n.actor} />
          <div class="min-w-0 grow">
            <NoteHeader
              $note={n}
              connections={props.connections}
              pinConnections={props.pinConnections}
              onDeleted={props.onDeleted}
            />
            <div
              ref={setProseRef}
              innerHTML={n.content}
              lang={n.language ?? undefined}
              class="prose dark:prose-invert mt-1 break-words overflow-wrap"
            />
            <MentionHoverCardLayer state={mentionState} />
            <NoteMedia $note={n} />
            <LinkPreview $note={n} />
            {
              /* `keyed`: avoid Solid's stale-accessor race when this
               Relay field flips to null inside a `batch()` update. */
            }
            <Show keyed when={n.quotedPost}>
              {(quotedPost) => <QuotedPostCard $post={quotedPost} />}
            </Show>
            <PostControls
              $post={n}
              bookmarkListConnections={props.bookmarkListConnections}
            />
          </div>
        </div>
      )}
    </Show>
  );
}
