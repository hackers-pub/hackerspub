import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { LinkCreatorAttribution } from "~/components/LinkCreatorAttribution.tsx";
import { LinkPreview_note$key } from "./__generated__/LinkPreview_note.graphql.ts";

export interface LinkPreviewProps {
  $note: LinkPreview_note$key;
}

export function LinkPreview(props: LinkPreviewProps) {
  const note = createFragment(
    graphql`
      fragment LinkPreview_note on Note {
        media {
          url
        }
        quotedPost {
          __typename
        }
        quoteTargetState
        link {
          url
          title
          description
          author
          siteName
          image {
            url
            width
            height
            alt
          }
          creator {
            ...LinkCreatorAttribution_creator
          }
        }
      }
    `,
    () => props.$note,
  );

  const shouldShowLink = () => {
    const n = note();
    return n && n.media.length === 0 && n.quotedPost == null &&
      n.quoteTargetState == null && n.link;
  };

  return (
    /* `keyed`: avoid Solid's stale-accessor race when this Relay-derived
       field flips to null inside a `batch()` update. */
    <Show keyed when={shouldShowLink()}>
      {(link) => {
        const image = link.image;
        const layoutMode = image == null ||
            (image.width != null && image.height != null &&
              image.width / image.height > 1.5)
          ? "wide"
          : "compact";
        const author = link.author;

        return (
          <div class="mt-4 overflow-hidden rounded-lg border bg-card shadow-sm">
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              data-layout={layoutMode}
              class="grid gap-0 bg-background transition-colors hover:bg-muted/30 data-[layout=compact]:grid-cols-[7rem_1fr] data-[layout=wide]:grid-cols-1 sm:data-[layout=compact]:grid-cols-[9rem_1fr]"
            >
              <Show keyed when={image}>
                {(img) => (
                  <div
                    data-layout={layoutMode}
                    class="min-w-0 bg-muted/40 data-[layout=compact]:border-r data-[layout=wide]:border-b"
                  >
                    <img
                      src={img.url}
                      alt={img.alt ?? undefined}
                      width={img.width ?? undefined}
                      height={img.height ?? undefined}
                      style={img.width != null && img.height != null
                        ? `aspect-ratio: ${img.width} / ${img.height}`
                        : undefined}
                      class="h-full w-full object-cover data-[layout=wide]:max-h-64"
                      data-layout={layoutMode}
                    />
                  </div>
                )}
              </Show>
              <div class="min-w-0 p-4">
                <p class="font-semibold leading-snug break-words">
                  {link.title}
                </p>
                <Show
                  when={link.description ||
                    (author && !URL.canParse(author))}
                >
                  <p class="mt-2 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">
                    <Show keyed when={author}>
                      {(author) => (
                        <>
                          <span class="font-bold">{author}</span>
                          <Show when={link.description}>·</Show>
                        </>
                      )}
                    </Show>
                    {link.description}
                  </p>
                </Show>
                <p class="mt-3 text-xs">
                  <span class="font-medium uppercase text-muted-foreground">
                    {new URL(link.url).host}
                  </span>
                  {/* `keyed`: same race shape; siteName can flip to null. */}
                  <Show keyed when={link.siteName}>
                    {(siteName) => (
                      <>
                        <span class="text-muted-foreground">·</span>
                        <span class="text-muted-foreground font-bold">
                          {siteName}
                        </span>
                      </>
                    )}
                  </Show>
                </p>
              </div>
            </a>
            {/* `keyed`: same race shape; creator can flip to null. */}
            <Show keyed when={link.creator}>
              {(creator) => (
                <LinkCreatorAttribution
                  $creator={creator}
                  class="border-t bg-muted/40 p-4"
                />
              )}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
