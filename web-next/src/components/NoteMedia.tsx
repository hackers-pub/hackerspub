import { graphql } from "relay-runtime";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { NoteMedia_note$key } from "./__generated__/NoteMedia_note.graphql.ts";

interface NoteMediaProps {
  $note: NoteMedia_note$key;
}

type Medium = {
  url: string;
  alt?: string | null;
  type: string;
  width?: number | null;
  height?: number | null;
  thumbnailUrl?: string | null;
  sensitive: boolean;
};

export function NoteMedia(props: NoteMediaProps) {
  const { t } = useLingui();
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

  const [openIndex, setOpenIndex] = createSignal<number | null>(null);

  function imageButton(medium: Medium, imageIndex: number, imgClass: string) {
    return (
      <button
        type="button"
        class="p-0 border-0 bg-transparent cursor-pointer block"
        aria-label={medium.alt?.trim() || t`View image`}
        onClick={() => setOpenIndex(imageIndex)}
      >
        <img
          src={medium.url}
          alt={medium.alt ?? undefined}
          class={`object-cover ${imgClass}`}
        />
      </button>
    );
  }

  function plainMedia(medium: Medium, imgClass: string) {
    if (medium.type.startsWith("video/")) {
      return (
        <video
          src={medium.url}
          poster={medium.thumbnailUrl ?? undefined}
          controls
          class={`object-cover ${imgClass}`}
        />
      );
    }
    return (
      <img
        src={medium.url}
        alt={medium.alt ?? undefined}
        class={`object-cover ${imgClass}`}
      />
    );
  }

  function mediaItem(
    medium: Medium,
    imageIndex: number | null,
    imgClass: string,
  ) {
    return imageIndex !== null
      ? imageButton(medium, imageIndex, imgClass)
      : plainMedia(medium, imgClass);
  }

  return (
    <Show keyed when={note()}>
      {(note) => {
        // Assign a positional index within image-type media only.
        let imageCounter = 0;
        const imageIndexFor = note.media.map((m) =>
          m.type.startsWith("image/") ? imageCounter++ : null
        );
        const imageMedia = note.media.filter((m) =>
          m.type.startsWith("image/")
        );

        return (
          <Show when={note.media.length > 0}>
            <div class="flex flex-row my-0.5">
              <Switch>
                <Match when={note.media.length === 1}>
                  {mediaItem(note.media[0], imageIndexFor[0], "max-h-80")}
                </Match>
                <Match
                  when={note.media.length >= 2 && note.media.length % 2 < 1}
                >
                  <div class="flex flex-col">
                    <For each={range(0, note.media.length / 2)}>
                      {(i) => (
                        <div class="flex flex-row">
                          <For each={note.media.slice(i * 2, i * 2 + 2)}>
                            {(medium, j) =>
                              mediaItem(
                                medium,
                                imageIndexFor[i * 2 + j()],
                                "w-[32.5ch] h-[32.5ch]",
                              )}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                </Match>
                <Match
                  when={note.media.length >= 3 && note.media.length % 2 > 0}
                >
                  <div class="flex flex-col">
                    {mediaItem(
                      note.media[0],
                      imageIndexFor[0],
                      "w-[65ch] h-[65ch]",
                    )}
                    <For each={range(0, (note.media.length - 1) / 2)}>
                      {(i) => (
                        <div class="flex flex-row">
                          <For each={note.media.slice(1 + i * 2, i * 2 + 3)}>
                            {(medium, j) =>
                              mediaItem(
                                medium,
                                imageIndexFor[1 + i * 2 + j()],
                                "w-[32.5ch] h-[32.5ch]",
                              )}
                          </For>
                        </div>
                      )}
                    </For>
                  </div>
                </Match>
              </Switch>
            </div>
            <ImageLightbox
              media={imageMedia}
              initialIndex={openIndex() ?? 0}
              open={openIndex() !== null}
              onClose={() => setOpenIndex(null)}
            />
          </Show>
        );
      }}
    </Show>
  );
}

function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i < end; i++) result.push(i);
  return result;
}
