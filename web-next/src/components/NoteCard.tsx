import { graphql } from "relay-runtime";
import { For, Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { InternalLink } from "~/components/InternalLink.tsx";
import { PostSharer } from "~/components/PostSharer.tsx";
import { QuotedPostCard } from "~/components/QuotedPostCard.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { VisibilityTag } from "~/components/VisibilityTag.tsx";
import { NoteCard_media$key } from "./__generated__/NoteCard_media.graphql.ts";
import { NoteCard_note$key } from "./__generated__/NoteCard_note.graphql.ts";
import { NoteCardInternal_note$key } from "./__generated__/NoteCardInternal_note.graphql.ts";

export interface NoteCardProps {
  $note: NoteCard_note$key;
}

export function NoteCard(props: NoteCardProps) {
  const note = createFragment(
    graphql`
      fragment NoteCard_note on Note {
        ...PostSharer_post
        ...NoteCardInternal_note
        ...NoteCard_media
        sharedPost {
          ...NoteCardInternal_note
          ...NoteCard_media
          quotedPost {
            ...QuotedPostCard_post
          }
        }
        quotedPost {
          ...QuotedPostCard_post
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
                <NoteMedia $note={note()} />
                <Show when={note().quotedPost}>
                  {(quotedPost) => <QuotedPostCard $post={quotedPost()} />}
                </Show>
              </>
            }
          >
            {(sharedPost) => (
              <>
                <PostSharer $post={note()} class="p-4 pb-0" />
                <NoteCardInternal $note={sharedPost()} />
                <NoteMedia $note={note()} />
                <Show when={sharedPost().quotedPost}>
                  {(quotedPost) => <QuotedPostCard $post={quotedPost()} />}
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
          url
          iri
        }
        content
        language
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
        <>
          <div class="flex gap-4 p-4">
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
                <a href={note().url || undefined}>
                  <Timestamp value={note().published} capitalizeFirstLetter />
                </a>{" "}
                &middot; <VisibilityTag visibility={note().visibility} />
              </div>
            </div>
          </div>
          <div
            innerHTML={note().content}
            lang={note().language ?? undefined}
            class="prose dark:prose-invert break-words overflow-wrap px-4 last:pb-4"
          />
        </>
      )}
    </Show>
  );
}

interface NoteMediaProps {
  $note: NoteCard_media$key;
}

function NoteMedia(props: NoteMediaProps) {
  const note = createFragment(
    graphql`
      fragment NoteCard_media on Note {
        media {
          alt
          type
          width
          height
          url
          thumbnailUrl
          sensitive
        }
      }
    `,
    () => props.$note,
  );

  return (
    <Show when={note()}>
      {(note) => (
        <Show when={note().media.length > 0}>
          <div class="mt-4 flex flex-row">
            <Switch>
              <Match when={note().media.length === 1}>
                <img
                  src={note().media[0].url}
                  alt={note().media[0].alt ?? undefined}
                  class="object-cover w-[65ch] h-[65ch]"
                />
              </Match>
              <Match
                when={note().media.length >= 2 && note().media.length % 2 < 1}
              >
                <div class="flex flex-col">
                  <For each={range(0, note().media.length / 2)}>
                    {(i) => (
                      <div class="flex flex-row">
                        <For each={note().media.slice(i * 2, i * 2 + 2)}>
                          {(medium) => (
                            <img
                              src={medium.url}
                              alt={medium.alt ?? undefined}
                              class="object-cover w-[32.5ch] h-[32.5ch]"
                            />
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </Match>
              <Match
                when={note().media.length >= 3 && note().media.length % 2 > 0}
              >
                <div class="flex flex-col">
                  <img
                    src={note().media[0].url}
                    alt={note().media[0].alt ?? undefined}
                    class="object-cover w-[65ch] h-[65ch]"
                  />
                  <For each={range(0, (note().media.length - 1) / 2)}>
                    {(i) => (
                      <div class="flex flex-row">
                        <For each={note().media.slice(1 + i * 2, i * 2 + 3)}>
                          {(medium) => (
                            <img
                              src={medium.url}
                              alt={medium.alt ?? undefined}
                              class="object-cover w-[32.5ch] h-[32.5ch]"
                            />
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </Match>
            </Switch>
          </div>
        </Show>
      )}
    </Show>
  );
}

function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i < end; i++) result.push(i);
  return result;
}
