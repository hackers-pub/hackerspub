import { renderCustomEmojis } from "../models/emoji.ts";
import { sanitizeExcerptHtml } from "../models/markup.ts";

export interface ExcerptProps {
  class?: string;
  html: string;
  emojis?: Record<string, string>;
  lang?: string;
}

export function Excerpt(
  { class: className, html, emojis, lang }: ExcerptProps,
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
        ${className}
      `}
      lang={lang}
      dangerouslySetInnerHTML={{
        __html: renderCustomEmojis(sanitizeExcerptHtml(html), emojis ?? {}),
      }}
    />
  );
}
