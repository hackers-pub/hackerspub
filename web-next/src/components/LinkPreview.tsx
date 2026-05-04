import { graphql } from "relay-runtime";
import { Show } from "solid-js";
import { createFragment } from "solid-relay";
import { InternalLink } from "~/components/InternalLink.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { LinkPreview_note$key } from "./__generated__/LinkPreview_note.graphql.ts";

export interface LinkPreviewProps {
  $note: LinkPreview_note$key;
}

export function LinkPreview(props: LinkPreviewProps) {
  const { t } = useLingui();
  const note = createFragment(
    graphql`
      fragment LinkPreview_note on Note {
        media {
          url
        }
        quotedPost {
          __typename
        }
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
            name
            local
            username
            handle
            avatarInitials
            avatarUrl
            url
            iri
          }
        }
      }
    `,
    () => props.$note,
  );

  const shouldShowLink = () => {
    const n = note();
    return n && n.media.length === 0 && n.quotedPost == null && n.link;
  };

  return (
    /* `keyed`: avoid Solid's stale-accessor race when this Relay-derived
       field flips to null inside a `batch()` update. */
    <Show keyed when={shouldShowLink()}>
      {(link) => {
        const image = link.image;
        const layoutMode = image?.width != null && image?.height != null &&
            image.width / image.height > 1.5
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
                <div class="flex gap-1.5 border-t bg-muted/40 p-4">
                  <span>{t`Link author:`}</span>
                  <Avatar class="size-6">
                    <InternalLink
                      href={creator.url ?? creator.iri}
                      internalHref={creator.local
                        ? `/@${creator.username}`
                        : `/${creator.handle}`}
                    >
                      <AvatarImage
                        src={creator.avatarUrl}
                        class="size-6"
                      />
                      <AvatarFallback class="size-6">
                        {creator.avatarInitials}
                      </AvatarFallback>
                    </InternalLink>
                  </Avatar>
                  <div>
                    <Show when={(creator.name ?? "").trim() !== ""}>
                      <InternalLink
                        href={creator.url ?? creator.iri}
                        internalHref={creator.local
                          ? `/@${creator.username}`
                          : `/${creator.handle}`}
                        innerHTML={creator.name ?? ""}
                        class="font-semibold"
                      />
                      {" "}
                    </Show>
                    <span class="select-all text-muted-foreground">
                      {creator.handle}
                    </span>
                  </div>
                </div>
              )}
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
