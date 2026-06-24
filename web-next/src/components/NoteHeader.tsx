import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NoteHeader_note$key } from "./__generated__/NoteHeader_note.graphql.ts";
import { InternalLink } from "./InternalLink.tsx";
import { PostAuthorLine } from "./PostAuthor.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { VisibilityTag } from "./VisibilityTag.tsx";

export interface NoteHeaderProps {
  $note: NoteHeader_note$key;
}

export function NoteHeader(props: NoteHeaderProps) {
  const note = createFragment(
    graphql`
      fragment NoteHeader_note on Note {
        id
        uuid
        sourceId
        visibility
        published
        url
        iri
        actor {
          handle
          username
          local
        }
        ...PostAuthorLine_post
      }
    `,
    () => props.$note,
  );

  return (
    <Show keyed when={note()}>
      {(n) => (
        <div class="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5">
          <PostAuthorLine $post={n} class="grow" />
          <span class="flex items-center gap-1.5 text-sm text-muted-foreground/70">
            <InternalLink
              href={n.url ?? n.iri}
              internalHref={`/${
                n.actor.local ? "@" + n.actor.username : n.actor.handle
              }/${n.sourceId ?? n.uuid}`}
            >
              <Timestamp value={n.published} capitalizeFirstLetter />
            </InternalLink>
            &middot;
            <VisibilityTag visibility={n.visibility} />
          </span>
        </div>
      )}
    </Show>
  );
}
