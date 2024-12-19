import {
  ArticleMetadata,
  type ArticleMetadataProps,
} from "./ArticleMetadata.tsx";
import { Excerpt } from "./Excerpt.tsx";
import { Msg } from "./Msg.tsx";

export interface ArticleExcerptProps extends ArticleMetadataProps {
  url: string | URL;
  target?: string;
  title?: string | null;
  contentHtml: string;
  lang?: string;
  replyTarget?: boolean;
}

export function ArticleExcerpt(props: ArticleExcerptProps) {
  return (
    <article
      class={`
        mt-5 border-l-4 border-l-stone-400 dark:border-l-stone-600 pl-4
        ${props.replyTarget ? "opacity-55 ml-6 pl-7" : ""}
        ${props.class}
      `}
    >
      {props.title &&
        (
          <h1
            class={`${
              props.replyTarget ? "text-xl" : "text-3xl"
            } font-bold mb-2`}
            lang={props.lang}
          >
            <a href={props.url.toString()} target={props.target}>
              {props.title}
            </a>
          </h1>
        )}
      <ArticleMetadata
        class="mb-2"
        authorUrl={props.authorUrl}
        authorName={props.authorName}
        authorHandle={props.authorHandle}
        authorAvatarUrl={props.authorAvatarUrl}
        published={props.published}
      />
      {!props.replyTarget && (
        <a href={props.url.toString()} target={props.target}>
          <Excerpt lang={props.lang} html={props.contentHtml} />
          <Msg $key="article.readMore" />
        </a>
      )}
    </article>
  );
}
