import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { NoteCard_note$key } from "./__generated__/NoteCard_note.graphql.ts";
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
        actor {
          name
          handle
          avatarUrl
        }
        content
        visibility
        published
        url
      }
    `,
    () => props.$note,
  );

  return (
    <Show when={note()}>
      {(note) => (
        <div class="flex flex-col p-4 gap-4 border-b last:border-none">
          <div class="flex gap-4">
            <Avatar class="size-12">
              <AvatarImage src={note().actor.avatarUrl} class="size-12" />
            </Avatar>
            <div class="flex flex-col">
              <div>
                <span class="font-semibold">{note().actor.name}</span>{" "}
                <span class="select-all opacity-65">{note().actor.handle}</span>
              </div>
              <div class="flex flex-row opacity-65 gap-1">
                <Timestamp value={note().published} /> &middot;{" "}
                <VisibilityTag visibility={note().visibility} />
              </div>
            </div>
          </div>
          <div innerHTML={note().content}></div>
        </div>
      )}
    </Show>
  );
}
