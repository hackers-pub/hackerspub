import { sanitizeHtml } from "../models/markup.ts";
import type { PostVisibility } from "../models/schema.ts";
import { Translation } from "./Msg.tsx";
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
  authorAvatarUrl?: string | null;
  published: Date;
}

export function NoteExcerpt(props: NoteExcerptProps) {
  return (
    <Translation>
      {(_, lang) => (
        <article class={`mt-5 flex flex-col ${props.class}`}>
          <div class="flex">
            {props.authorAvatarUrl && (
              <a href={props.authorUrl}>
                <img
                  src={props.authorAvatarUrl}
                  width={48}
                  height={48}
                  class="inline-block mr-2 align-text-bottom"
                />
              </a>
            )}
            <div
              class={`flex flex-col ${
                props.authorAvatarUrl == null ? "ml-14" : ""
              }`}
            >
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
              </div>
            </div>
          </div>
          <div
            class="ml-14 mt-2 prose dark:prose-invert"
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
