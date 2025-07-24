import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NoteCard_note$key } from "./__generated__/NoteCard_note.graphql.ts";
import { NoteCardInternal_note$key } from "./__generated__/NoteCardInternal_note.graphql.ts";
import { PostSharer } from "./PostSharer.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { Avatar, AvatarImage } from "./ui/avatar.tsx";
import { VisibilityTag } from "./VisibilityTag.tsx";

export interface NoteCardProps {
  $note: NoteCard_note$key;
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
    <div class="flex flex-col p-4 gap-4 border-b last:border-none">
      <Show when={note()}>
        {(note) => (
          <Show
            when={note().sharedPost}
            fallback={<NoteCardInternal $note={note()} />}
          >
            {(sharedPost) => (
              <>
                <PostSharer $post={note()} />
                <NoteCardInternal $note={sharedPost()} />
              </>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}

interface NoteCardInternalProps {
  $note: NoteCardInternal_note$key;
}

function NoteCardInternal(props: NoteCardInternalProps) {
  const note = createFragment(
    graphql`
      fragment NoteCardInternal_note on Note {
        actor {
          name
          handle
          avatarUrl
        }
        content
        language
        visibility
        published
      }
    `,
    () => props.$note,
  );

  return (
    <Show when={note()}>
      {(note) => (
        <>
          <div class="flex gap-4">
            <Avatar class="size-12">
              <AvatarImage src={note().actor.avatarUrl} class="size-12" />
            </Avatar>
            <div class="flex flex-col">
              <div>
                <Show when={(note().actor.name ?? "").trim() !== ""}>
                  <span
                    innerHTML={note().actor.name ?? ""}
                    class="font-semibold"
                  />
                  {" "}
                </Show>
                <span class="select-all text-muted-foreground">
                  {note().actor.handle}
                </span>
              </div>
              <div class="flex flex-row text-muted-foreground gap-1">
                <Timestamp value={note().published} capitalizeFirstLetter />
                {" "}
                &middot; <VisibilityTag visibility={note().visibility} />
              </div>
            </div>
          </div>
          <div
            innerHTML={note().content}
            lang={note().language ?? undefined}
            class="prose dark:prose-invert break-words overflow-wrap"
          >
          </div>
        </>
      )}
    </Show>
  );
}
