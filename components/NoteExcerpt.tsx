import { sanitizeHtml } from "../models/markup.ts";
import type { PostVisibility } from "../models/schema.ts";
import { Msg, Translation } from "./Msg.tsx";
import { PostVisibilityIcon } from "./PostVisibilityIcon.tsx";

export interface NoteExcerptProps {
  class?: string;
  url: string | URL;
  target?: string;
  contentHtml: string;
  visibility: PostVisibility;
  lang?: string;
  authorUrl: string;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl: string;
  sharer?: {
    url: string;
    name: string;
  };
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
            <a href={props.authorUrl}>
              <img
                src={props.authorAvatarUrl}
                width={48}
                height={48}
                class="inline-block mr-2 align-text-bottom"
              />
            </a>
            <div class="flex flex-col">
              <a href={props.authorUrl}>
                <strong class="text-black dark:text-white">
                  {props.authorName}
                </strong>{" "}
                <span class="text-stone-500 dark:text-stone-400 select-all before:content-['('] after:content-[')']">
                  {props.authorHandle}
                </span>
              </a>
              <div class="flex text-stone-500 dark:text-stone-400">
                <a
                  href={props.url.toString()}
                  class="after:content-['_·'] mr-1"
                >
                  <time
                    datetime={props.published.toISOString()}
                  >
                    {props.published.toLocaleString(lang, {
                      dateStyle: "long",
                      timeStyle: "short",
                    })}
                  </time>
                </a>
                <PostVisibilityIcon
                  class="inline-block"
                  visibility={props.visibility}
                />
                {props.sharer && (
                  <span class="before:content-['·_'] ml-1">
                    <Msg
                      $key="note.sharedBy"
                      name={
                        <a href={props.sharer.url} class="font-bold">
                          {props.sharer.name}
                        </a>
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
              __html: sanitizeHtml(props.contentHtml),
            }}
          >
          </div>
        </article>
      )}
    </Translation>
  );
}
