import { renderCustomEmojis } from "@hackerspub/models/emoji";
import { sanitizeExcerptHtml } from "@hackerspub/models/html";

export interface ExcerptProps {
  class?: string;
  html: string;
  emojis?: Record<string, string>;
  lang?: string | null;
}

export function Excerpt(
  props: ExcerptProps,
) {
  return (
    <div
      class={`
        prose dark:prose-invert truncate overflow-y-hidden max-h-[2rem] leading-8
        prose-headings:text-base prose-headings:inline
        prose-blockquote:inline prose-pre:inline prose-ol:inline prose-ul:inline
        prose-p:inline prose-li:inline prose-table:inline prose-thead:inloine
        prose-tr:inline prose-th:inline prose-td:inline
        prose-a:no-underline prose-a:font-normal
        ${props.class || ""}
      `}
      lang={props.lang ?? undefined}
      innerHTML={renderCustomEmojis(
        sanitizeExcerptHtml(props.html),
        props.emojis ?? {},
      )}
    />
  );
}
