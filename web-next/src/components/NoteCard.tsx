import { graphql } from "relay-runtime";
import { For, Match, Show, Switch } from "solid-js";
import { createFragment } from "solid-relay";
import { InternalLink } from "~/components/InternalLink.tsx";
import { PostControls } from "~/components/PostControls.tsx";
import { PostSharer } from "~/components/PostSharer.tsx";
import { QuotedPostCard } from "~/components/QuotedPostCard.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { VisibilityTag } from "~/components/VisibilityTag.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { NoteCard_link$key } from "./__generated__/NoteCard_link.graphql.ts";
import { NoteCard_media$key } from "./__generated__/NoteCard_media.graphql.ts";
import { NoteCard_note$key } from "./__generated__/NoteCard_note.graphql.ts";
import { NoteCardInternal_note$key } from "./__generated__/NoteCardInternal_note.graphql.ts";

export interface NoteCardProps {
  $note: NoteCard_note$key;
  zoom?: boolean;
}

export function NoteCard(props: NoteCardProps) {
  const note = createFragment(
    graphql`
      fragment NoteCard_note on Note {
        ...PostSharer_post
        ...NoteCardInternal_note
        ...NoteCard_media
        ...NoteCard_link
        ...PostControls_note
        sharedPost {
          ...NoteCardInternal_note
          ...NoteCard_media
          ...NoteCard_link
          quotedPost {
            ...QuotedPostCard_post
          }
        }
        quotedPost {
          ...QuotedPostCard_post
        }
        media {
          id
        }
        link {
          id
        }
      }
    `,
    () => props.$note,
  );

  return (
    <div
      class="flex flex-col border-b last:border-none last:*:last:rounded-b-xl"
      classList={{ "text-xl": props.zoom }}
    >
      <Show when={note()}>
        {(note) => (
          <Show
            when={note().sharedPost}
            fallback={
              <>
                <NoteCardInternal $note={note()} zoom={props.zoom} />
                <NoteMedia $note={note()} />
                <LinkPreview $note={note()} />
                <Show when={note().quotedPost}>
                  {(quotedPost) => <QuotedPostCard $post={quotedPost()} />}
                </Show>
                <PostControls
                  $note={note()}
                  classList={{
                    "mt-4": note().quotedPost == null && note().link == null &&
                      note().media.length < 1,
                  }}
                />
              </>
            }
          >
            {(sharedPost) => (
              <>
                <PostSharer $post={note()} class="p-4 pb-0" />
                <NoteCardInternal $note={sharedPost()} zoom={props.zoom} />
                <NoteMedia $note={note()} />
                <LinkPreview $note={sharedPost()} />
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
  zoom?: boolean;
}

function NoteCardInternal(props: NoteCardInternalProps) {
  const note = createFragment(
    graphql`
      fragment NoteCardInternal_note on Note {
        __id
        uuid
        actor {
          name
          handle
          username
          avatarUrl
          avatarInitials
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
        engagementStats {
          replies
          shares
          quotes
          reactions
        }
        reactionGroups {
          ... on EmojiReactionGroup {
            emoji
          }
          ... on CustomEmojiReactionGroup {
            customEmoji {
              name
              imageUrl
            }
          }
        }
      }
    `,
    () => props.$note,
  );

  return (
    <Show when={note()}>
      {(note) => (
        <>
          <div class="flex gap-4 p-4">
            <Avatar
              classList={{ "size-12": !props.zoom, "size-14": props.zoom }}
            >
              <InternalLink
                href={note().actor.url ?? note().actor.iri}
                internalHref={note().actor.local
                  ? `/@${note().actor.username}`
                  : `/${note().actor.handle}`}
              >
                <AvatarImage
                  src={note().actor.avatarUrl}
                  classList={{ "size-12": !props.zoom, "size-14": props.zoom }}
                />
                <AvatarFallback
                  classList={{ "size-12": !props.zoom, "size-14": props.zoom }}
                >
                  {note().actor.avatarInitials}
                </AvatarFallback>
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
                  internalHref={`/${
                    note().actor.local
                      ? "@" + note().actor.username
                      : note().actor.handle
                  }/${note().uuid}`}
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
            class="prose dark:prose-invert break-words overflow-wrap px-4 last:pb-4"
            classList={{ "prose-xl": props.zoom }}
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

interface LinkPreviewProps {
  $note: NoteCard_link$key;
}

function LinkPreview(props: LinkPreviewProps) {
  const { t } = useLingui();
  const note = createFragment(
    graphql`
      fragment NoteCard_link on Note {
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
