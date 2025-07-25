import { graphql } from "relay-runtime";
import { Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { NoteCard_note$key } from "./__generated__/NoteCard_note.graphql.ts";
import { NoteCard_quotedNote$key } from "./__generated__/NoteCard_quotedNote.graphql.ts";
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
          quotedPost {
            __typename
            ...NoteCard_quotedNote
          }
        }
        quotedPost {
          __typename
          ...NoteCard_quotedNote
        }
      }
    `,
    () => props.$note,
  );

  return (
    <div class="flex flex-col border-b last:border-none last:*:last:rounded-b-xl">
      <Show when={note()}>
        {(note) => (
          <Show
            when={note().sharedPost}
            fallback={
              <>
                <NoteCardInternal $note={note()} />
                <Show when={note().quotedPost}>
                  {(quotedPost) => (
                    <Switch>
                      <Match when={quotedPost().__typename === "Note"}>
                        <QuotedNoteCard $note={quotedPost()} />
                      </Match>
                    </Switch>
                  )}
                </Show>
              </>
            }
          >
            {(sharedPost) => (
              <>
                <PostSharer $post={note()} class="p-4 pb-0" />
                <NoteCardInternal $note={sharedPost()} />
                <Show when={sharedPost().quotedPost}>
                  {(quotedPost) => (
                    <Switch>
                      <Match when={quotedPost().__typename === "Note"}>
                        <QuotedNoteCard $note={quotedPost()} />
                      </Match>
                    </Switch>
                  )}
                </Show>
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
        __id
        actor {
          name
          handle
          username
          avatarUrl
          local
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
          <div class="flex gap-4 p-4">
            <Avatar class="size-12">
              <a
                href={note().actor.local
                  ? `/@${note().actor.username}`
                  : `/${note().actor.handle}`}
                target={note().actor.local ? undefined : "_self"}
              >
                <AvatarImage src={note().actor.avatarUrl} class="size-12" />
              </a>
            </Avatar>
            <div class="flex flex-col">
              <div>
                <Show when={(note().actor.name ?? "").trim() !== ""}>
                  <a
                    href={note().actor.local
                      ? `/@${note().actor.username}`
                      : `/${note().actor.handle}`}
                    target={note().actor.local ? undefined : "_self"}
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
            class="prose dark:prose-invert break-words overflow-wrap px-4 last:pb-4"
          >
          </div>
        </>
      )}
    </Show>
  );
}

interface QuotedNoteCardProps {
  $note: NoteCard_quotedNote$key;
}

function QuotedNoteCard(props: QuotedNoteCardProps) {
  const note = createFragment(
    graphql`
      fragment NoteCard_quotedNote on Note {
        __id
        actor {
          name
          handle
          username
          avatarUrl
          local
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
          <div class="w-0 h-0 border-l-[15px] border-r-[15px] border-b-[20px] border-l-transparent border-r-transparent border-b-muted ml-4" />
          <div class="flex flex-col bg-muted p-4">
            <div class="flex gap-4">
              <Avatar class="size-12">
                <a
                  href={note().actor.local
                    ? `/@${note().actor.username}`
                    : `/${note().actor.handle}`}
                  target={note().actor.local ? undefined : "_self"}
                >
                  <AvatarImage src={note().actor.avatarUrl} class="size-12" />
                </a>
              </Avatar>
              <div class="flex flex-col">
                <div>
                  <Show when={(note().actor.name ?? "").trim() !== ""}>
                    <a
                      href={note().actor.local
                        ? `/@${note().actor.username}`
                        : `/${note().actor.handle}`}
                      target={note().actor.local ? undefined : "_self"}
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
              class="prose dark:prose-invert break-words overflow-wrap px-4 pt-4"
            >
            </div>
          </div>
        </>
      )}
    </Show>
  );
}
