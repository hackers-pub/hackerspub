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
    <Show when={shouldShowLink()}>
      {(link) => {
        const image = link().image;
        const layoutMode = image?.width != null && image?.height != null &&
            image.width / image.height > 1.5
          ? "wide"
          : "compact";
        const author = link().author;

        return (
          <div class="mt-4">
            <a
              href={link().url}
              target="_blank"
              rel="noopener noreferrer"
              data-layout={layoutMode}
              class="border-t border-border bg-muted max-w-prose grid data-[layout=wide]:grid-cols-1 data-[layout=compact]:grid-cols-[auto_1fr] gap-0"
            >
              <Show when={image}>
                {(img) => (
                  <div class="min-w-0">
                    <img
                      src={img().url}
                      alt={img().alt ?? undefined}
                      width={img().width ?? undefined}
                      height={img().height ?? undefined}
                      style={img().width != null && img().height != null
                        ? `aspect-ratio: ${img().width} / ${img().height}`
                        : undefined}
                      class="m-auto data-[layout=wide]:w-full data-[layout=wide]:h-auto data-[layout=compact]:max-h-40 data-[layout=compact]:w-auto"
                      data-layout={layoutMode}
                    />
                  </div>
                )}
              </Show>
              <div>
                <p class="m-4 font-bold break-words">{link().title}</p>
                <Show
                  when={link().description ||
                    (author && !URL.canParse(author))}
                >
                  <p class="m-4 text-muted-foreground line-clamp-2 break-words">
                    <Show when={author}>
                      {(author) => (
                        <>
                          <span class="font-bold">{author()}</span>
                          <Show when={link().description}>·</Show>
                        </>
                      )}
                    </Show>
                    {link().description}
                  </p>
                </Show>
                <p class="m-4">
                  <span class="text-muted-foreground uppercase">
                    {new URL(link().url).host}
                  </span>
                  <Show when={link().siteName}>
                    {(siteName) => (
                      <>
                        <span class="text-muted-foreground">·</span>
                        <span class="text-muted-foreground font-bold">
                          {siteName()}
                        </span>
                      </>
                    )}
                  </Show>
                </p>
              </div>
            </a>
            <Show when={link().creator}>
              {(creator) => (
                <div class="bg-border p-4 flex gap-1.5">
                  <span>{t`Link author: `}</span>
                  <Avatar class="size-6">
                    <InternalLink
                      href={creator().url ?? creator().iri}
                      internalHref={creator().local
                        ? `/@${creator().username}`
                        : `/${creator().handle}`}
                    >
                      <AvatarImage
                        src={creator().avatarUrl}
                        class="size-6"
                      />
                      <AvatarFallback class="size-6">
                        {creator().avatarInitials}
                      </AvatarFallback>
                    </InternalLink>
                  </Avatar>
                  <div>
                    <Show when={(creator().name ?? "").trim() !== ""}>
                      <InternalLink
                        href={creator().url ?? creator().iri}
                        internalHref={creator().local
                          ? `/@${creator().username}`
                          : `/${creator().handle}`}
                        innerHTML={creator().name ?? ""}
                        class="font-semibold"
                      />
                      {" "}
                    </Show>
                    <span class="select-all text-muted-foreground">
                      {creator().handle}
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
