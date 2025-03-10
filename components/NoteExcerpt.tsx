import { escape } from "@std/html/entities";
import { Link } from "../islands/Link.tsx";
import { Timestamp } from "../islands/Timestamp.tsx";
import { renderCustomEmojis } from "../models/emoji.ts";
import type { PostMedium, PostVisibility } from "../models/schema.ts";
import { sanitizeHtml } from "../models/xss.ts";
import { Msg, Translation } from "./Msg.tsx";
import { PostVisibilityIcon } from "./PostVisibilityIcon.tsx";

export interface NoteExcerptProps {
  class?: string;
  url: string | URL;
  internalUrl?: string;
  target?: string;
  contentHtml: string;
  emojis?: Record<string, string>;
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
    name: string;
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
          class={`${props.reply ? "mt-2" : "mt-5"} flex flex-col ${
            props.replyTarget ? "opacity-55" : ""
          } ${props.class ?? ""}`}
        >
          <div class="flex">
            <Link
              href={props.authorUrl}
              internalHref={props.authorInternalUrl}
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
              <div class="flex text-stone-500 dark:text-stone-400">
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
                  <span class="before:content-['·_'] ml-1">
                    <Msg
                      $key="note.sharedBy"
                      name={
                        <Link
                          href={props.sharer.url}
                          internalHref={props.sharer.internalUrl}
                          class="font-bold"
                        >
                          {props.sharer.name}
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
              mt-2 prose dark:prose-invert
              ${
              props.replyTarget
                ? "ml-6 pl-7 border-stone-400 dark:border-stone-600 border-l-4"
                : "ml-14"
            }
            `}
            lang={props.lang}
            dangerouslySetInnerHTML={{
              __html: renderCustomEmojis(
                sanitizeHtml(props.contentHtml),
                props.emojis ?? {},
              ),
            }}
          >
          </div>
          {props.media.length > 0 && (
            <div class="flex justify-center">
              {props.media.map((medium) => (
                <img
                  src={medium.url}
                  alt={medium.alt ?? ""}
                  width={medium.width ?? undefined}
                  height={medium.height ?? undefined}
                  class="mt-2 object-contain max-w-96 max-h-96"
                />
              ))}
            </div>
          )}
        </article>
      )}
    </Translation>
  );
}
