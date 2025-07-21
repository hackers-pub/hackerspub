import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import {
  NoteCard_note$key,
  PostVisibility,
} from "./__generated__/NoteCard_note.graphql.ts";
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
        language
        visibility
        published
        url
        sharedPost {
          actor {
            name
            handle
            avatarUrl
          }
          content
          language
          visibility
          published
          url
        }
      }
    `,
    () => props.$note,
  );

  return (
    <Show when={note()}>
      {(note) => (
        <Show
          when={note().sharedPost}
          fallback={
            <NoteCardInternal
              actor={note().actor}
              visibility={note().visibility}
              published={note().published}
              content={note().content}
              language={note().language}
            />
          }
        >
          {(sharedPost) => (
            <NoteCardInternal
              actor={sharedPost().actor}
              visibility={sharedPost().visibility}
              published={sharedPost().published}
              content={sharedPost().content}
              language={sharedPost().language}
            />
          )}
        </Show>
      )}
    </Show>
  );
}

interface NoteCardInternalProps {
  actor: {
    name: string | null | undefined;
    handle: string;
    avatarUrl: string;
  };
  visibility: PostVisibility;
  published: string | Date;
  content: string;
  language: string | null | undefined;
}

function NoteCardInternal(props: NoteCardInternalProps) {
  return (
    <div class="flex flex-col p-4 gap-4 border-b last:border-none">
      <div class="flex gap-4">
        <Avatar class="size-12">
          <AvatarImage src={props.actor.avatarUrl} class="size-12" />
        </Avatar>
        <div class="flex flex-col">
          <div>
            <Show when={(props.actor.name ?? "").trim() !== ""}>
              <span class="font-semibold">{props.actor.name}</span>
              {" "}
            </Show>
            <span class="select-all text-muted-foreground">
              {props.actor.handle}
            </span>
          </div>
          <div class="flex flex-row text-muted-foreground gap-1">
            <Timestamp value={props.published} /> &middot;{" "}
            <VisibilityTag visibility={props.visibility} />
          </div>
        </div>
      </div>
      <div
        innerHTML={props.content}
        lang={props.language ?? undefined}
        class="prose dark:prose-invert"
      >
      </div>
    </div>
  );
}
