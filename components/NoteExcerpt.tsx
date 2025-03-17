import { escape } from "@std/html/entities";
import { Link } from "../islands/Link.tsx";
import { MediumThumbnail } from "../islands/MediumThumbnail.tsx";
import { Timestamp } from "../islands/Timestamp.tsx";
import { renderCustomEmojis } from "../models/emoji.ts";
import { preprocessContentHtml } from "../models/html.ts";
import type {
  Actor,
  Mention,
  PostMedium,
  PostVisibility,
} from "../models/schema.ts";
import { Msg, Translation } from "./Msg.tsx";
import { PostVisibilityIcon } from "./PostVisibilityIcon.tsx";

export interface NoteExcerptProps {
  class?: string;
  url: string | URL;
  internalUrl?: string;
  target?: string;
  contentHtml: string;
  emojis?: Record<string, string>;
  mentions: (Mention & { actor: Actor })[];
  visibility: PostVisibility;
  lang?: string;
  authorUrl: string;
  authorInternalUrl?: string;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl: string;
  authorEmojis: Record<string, string>;
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
              mt-2 prose dark:prose-invert break-words overflow-wrap
              ${props.replyTarget ? "opacity-55" : ""}
              ${
              props.replyTarget
                ? "ml-6 pl-7 border-stone-400 dark:border-stone-600 border-l-4"
                : "ml-14"
            }
            `}
            lang={props.lang}
            dangerouslySetInnerHTML={{
              __html: preprocessContentHtml(
                props.contentHtml,
                props.mentions,
                props.emojis ?? {},
              ),
            }}
          >
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
                  class={props.replyTarget ? "opacity-55" : ""}
                />
              ))}
            </div>
          )}
        </article>
      )}
    </Translation>
  );
}
