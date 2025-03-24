import { escape } from "@std/html/entities";
import { Link } from "../islands/Link.tsx";
import { MediumThumbnail } from "../islands/MediumThumbnail.tsx";
import { QuotedPostCard } from "../islands/QuotedPostCard.tsx";
import { Timestamp } from "../islands/Timestamp.tsx";
import { renderCustomEmojis } from "../models/emoji.ts";
import { preprocessContentHtml } from "../models/html.ts";
import type {
  Actor,
  Mention,
  PostLink,
  PostMedium,
  PostVisibility,
} from "../models/schema.ts";
import type { Uuid } from "../models/uuid.ts";
import { Msg, Translation } from "./Msg.tsx";
import { PostVisibilityIcon } from "./PostVisibilityIcon.tsx";

export interface NoteExcerptProps {
  class?: string;
  url: string | URL;
  internalUrl?: string;
  target?: string;
  sensitive: boolean;
  summary?: string;
  contentHtml: string;
  emojis?: Record<string, string>;
  mentions: (Mention & { actor: Actor })[];
  visibility: PostVisibility;
  lang?: string;
  link?: PostLink & { creator?: Actor | null } | null;
  linkUrl?: string;
  authorUrl: string;
  authorInternalUrl?: string;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl: string;
  authorEmojis: Record<string, string>;
  quotedPostId?: Uuid;
  sharer?: {
    url: string;
    internalUrl?: string;
    avatarUrl: string;
    name: string;
    emojis: Record<string, string>;
  };
  media: PostMedium[];
  published: Date;
  replyTarget?: boolean;
  reply?: boolean;
}

export function NoteExcerpt(props: NoteExcerptProps) {
  return (
    <Translation>
      {(_, lang) => (
        <article
          class={`${props.reply ? "" : "mt-5"} flex flex-col ${
            props.class ?? ""
          }`}
        >
          <div class={`flex gap-2 ${props.replyTarget ? "opacity-55" : ""}`}>
            <Link
              href={props.authorUrl}
              internalHref={props.authorInternalUrl}
              class="w-12 h-12"
            >
              <img
                src={props.authorAvatarUrl}
                width={48}
                height={48}
                class="inline-block mr-2 align-text-bottom"
              />
            </Link>
            <div class="flex flex-col">
              <Link
                href={props.authorUrl}
                internalHref={props.authorInternalUrl}
              >
                <strong
                  class="text-black dark:text-white"
                  dangerouslySetInnerHTML={{
                    __html: renderCustomEmojis(
                      escape(props.authorName),
                      props.authorEmojis,
                    ),
                  }}
                />{" "}
                <span class="text-stone-500 dark:text-stone-400 select-all before:content-['('] after:content-[')']">
                  {props.authorHandle}
                </span>
              </Link>
              <div class="flex flex-wrap sm:flex-nowrap text-stone-500 dark:text-stone-400">
                <Link
                  href={props.url.toString()}
                  internalHref={props.internalUrl}
                  class="after:content-['_·'] mr-1"
                >
                  <Timestamp value={props.published} locale={lang} />
                </Link>
                <PostVisibilityIcon
                  class="inline-block"
                  visibility={props.visibility}
                />
                {props.sharer && (
                  <span class="w-full sm:w-auto sm:before:content-['·_'] sm:ml-1">
                    <Msg
                      $key="note.sharedBy"
                      name={
                        <Link
                          href={props.sharer.url}
                          internalHref={props.sharer.internalUrl}
                        >
                          <img
                            src={props.sharer.avatarUrl}
                            width={16}
                            height={16}
                            class="inline-block mr-1 mt-[2px] align-text-top"
                          />
                          <strong
                            dangerouslySetInnerHTML={{
                              __html: renderCustomEmojis(
                                escape(props.sharer.name),
                                props.sharer.emojis,
                              ),
                            }}
                          />
                        </Link>
                      }
                    />
                  </span>
                )}
              </div>
            </div>
          </div>
          <div
            class={`
              ${props.replyTarget ? "opacity-55" : ""}
              ${
              props.replyTarget
                ? "ml-6 pl-7 border-stone-400 dark:border-stone-600 border-l-4"
                : "ml-14"
            }
            `}
            lang={props.lang}
          >
            {props.summary && (
              <p class="my-2 text-stone-500 dark:text-stone-400 font-bold">
                {props.summary}
              </p>
            )}
            <div
              class={`
                mt-2 prose dark:prose-invert break-words overflow-wrap
                ${props.sensitive ? "blur-md hover:blur-0 transition-all" : ""}
              `}
              dangerouslySetInnerHTML={{
                __html: preprocessContentHtml(
                  props.contentHtml,
                  props.mentions,
                  props.emojis ?? {},
                ),
              }}
            />
            {props.media.length < 1 && props.quotedPostId == null &&
              props.link && (
              <div class="mt-4">
                <a
                  href={props.linkUrl ?? props.link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="block border border-stone-300 bg-stone-100 dark:border-stone-700 dark:bg-stone-800 max-w-prose"
                >
                  {props.link.imageUrl &&
                    (
                      <img
                        src={props.link.imageUrl}
                        alt={props.link.imageAlt ?? undefined}
                        width={props.link.imageWidth ?? undefined}
                        height={props.link.imageHeight ?? undefined}
                        class="w-full h-auto"
                      />
                    )}
                  <p class="m-4 font-bold">{props.link.title}</p>
                  {(props.link.description ||
                    props.link.author && !URL.canParse(props.link.author)) && (
                    <p class="m-4 text-stone-500 dark:text-stone-400 line-clamp-2">
                      {props.link.author && (
                        <>
                          <span class="font-bold">{props.link.author}</span>
                          {props.link.description && " · "}
                        </>
                      )}
                      {props.link.description}
                    </p>
                  )}
                  <p class="m-4">
                    <span class="text-stone-500 dark:text-stone-400 uppercase">
                      {new URL(props.link.url).host}
                    </span>
                    {props.link.siteName && (
                      <>
                        <span class="text-stone-500 dark:text-stone-400">
                          {" · "}
                        </span>
                        <span class="text-stone-500 dark:text-stone-400 font-bold">
                          {props.link.siteName}
                        </span>
                      </>
                    )}
                  </p>
                </a>
                {props.link.creator && (
                  <p class="max-w-prose p-4 bg-stone-300 dark:bg-stone-700 text-stone-700 dark:text-stone-300">
                    <Msg
                      $key="note.linkAuthor"
                      author={
                        <Link
                          href={props.link.creator.url ??
                            props.link.creator.iri}
                          internalHref={props.link.creator.accountId == null
                            ? `/${props.link.creator.handle}`
                            : `/@${props.link.creator.username}`}
                          class="font-bold text-stone-950 dark:text-stone-50"
                        >
                          {props.link.creator.avatarUrl && (
                            <img
                              src={props.link.creator.avatarUrl}
                              class="inline-block size-5 mr-1 align-text-top"
                            />
                          )}
                          <span
                            dangerouslySetInnerHTML={{
                              __html: props.link.creator.name == null
                                ? props.link.creator.username
                                : renderCustomEmojis(
                                  escape(props.link.creator.name),
                                  props.link.creator.emojis,
                                ),
                            }}
                          />
                          <span class="opacity-50 before:content-['_('] after:content-[')'] font-normal">
                            {props.link.creator.handle}
                          </span>
                        </Link>
                      }
                    />
                  </p>
                )}
              </div>
            )}
          </div>
          {props.media.length > 0 && (
            <div
              class={`
              flex justify-center w-full overflow-x-auto
              ${
                props.replyTarget
                  ? `
                    before:content-['.'] before:absolute before:w-1 before:left-[40px] before:xl:left-[calc((100%-1280px)/2+40px)]
                    before:opacity-55 before:bg-gradient-to-b before:from-stone-400 dark:before:from-stone-600 before:to-transparent
                    before:text-transparent
                  `
                  : ""
              }
            `}
            >
              {props.media.map((medium) => (
                <MediumThumbnail
                  key={medium.index}
                  medium={medium}
                  class={`
                    ${props.replyTarget ? "opacity-55" : ""}
                    ${
                    props.sensitive || medium.sensitive
                      ? "my-20 blur-2xl hover:blur-0 transition-all"
                      : ""
                  }
                  `}
                />
              ))}
            </div>
          )}
          {props.quotedPostId != null &&
            (
              <div
                class={`
                  ml-14
                  ${
                  props.replyTarget && props.media.length < 1
                    ? `
                      mb-2
                      before:content-['.'] before:absolute before:w-1 before:left-[40px] before:xl:left-[calc((100%-1280px)/2+40px)]
                      before:opacity-55 before:bg-gradient-to-b before:from-stone-400 dark:before:from-stone-600 before:to-transparent
                      before:text-transparent before:min-h-28
                      `
                    : ""
                }
                `}
              >
                <QuotedPostCard
                  id={props.quotedPostId}
                  language={lang}
                  class={`
                    mt-4 mb-2
                    ${props.replyTarget ? "opacity-55" : ""}
                  `}
                />
              </div>
            )}
        </article>
      )}
    </Translation>
  );
}
