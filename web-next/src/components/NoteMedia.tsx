import { graphql } from "relay-runtime";
import { For, Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { NoteMedia_note$key } from "./__generated__/NoteMedia_note.graphql.ts";

interface NoteMediaProps {
  $note: NoteMedia_note$key;
}

export function NoteMedia(props: NoteMediaProps) {
  const note = createFragment(
    graphql`
      fragment NoteMedia_note on Note {
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
          <div class="flex flex-row my-0.5">
            <Switch>
              <Match when={note().media.length === 1}>
                <img
                  src={note().media[0].url}
                  alt={note().media[0].alt ?? undefined}
                  class="object-cover max-h-80"
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
