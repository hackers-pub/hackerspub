import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { InternalLink } from "~/components/InternalLink.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { VisibilityTag } from "~/components/VisibilityTag.tsx";
import type { QuotedNoteCard_note$key } from "./__generated__/QuotedNoteCard_note.graphql.ts";

export interface QuotedNoteCardProps {
  readonly $note: QuotedNoteCard_note$key;
  readonly class?: string;
  readonly classList?: { [k: string]: boolean | undefined };
}

export function QuotedNoteCard(props: QuotedNoteCardProps) {
  const note = createFragment(
    graphql`
      fragment QuotedNoteCard_note on Note {
        __id
        uuid
        actor {
          name
          handle
          username
          avatarUrl
          local
          url
          iri
        }
        content
        language
        visibility
        published
        url
        iri
      }
    `,
    () => props.$note,
  );

  return (
    <Show when={note()}>
      {(note) => (
        <div class={props.class} classList={props.classList}>
          <div class="w-0 h-0 border-l-[15px] border-r-[15px] border-b-[20px] border-l-transparent border-r-transparent border-b-muted ml-4" />
          <div class="flex flex-col bg-muted p-4">
            <div class="flex gap-4">
              <Avatar class="size-12">
                <InternalLink
                  href={note().actor.url ?? note().actor.iri}
                  internalHref={note().actor.local
                    ? `/@${note().actor.username}`
                    : `/${note().actor.handle}`}
                >
                  <AvatarImage src={note().actor.avatarUrl} class="size-12" />
                </InternalLink>
              </Avatar>
              <div class="flex flex-col">
                <div>
                  <Show when={(note().actor.name ?? "").trim() !== ""}>
                    <InternalLink
                      href={note().actor.url ?? note().actor.iri}
                      internalHref={note().actor.local
                        ? `/@${note().actor.username}`
                        : `/${note().actor.handle}`}
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
                  <InternalLink
                    href={note().url ?? note().iri}
                    internalHref={note().actor.local
                      ? `/@${note().actor.username}/${note().uuid}`
                      : `/${note().actor.handle}/${note().uuid}`}
                  >
                    <Timestamp value={note().published} capitalizeFirstLetter />
                  </InternalLink>{" "}
                  &middot; <VisibilityTag visibility={note().visibility} />
                </div>
              </div>
            </div>
            <div
              innerHTML={note().content}
              lang={note().language ?? undefined}
              class="prose dark:prose-invert break-words overflow-wrap px-4 pt-4"
            />
          </div>
        </div>
      )}
    </Show>
  );
}
