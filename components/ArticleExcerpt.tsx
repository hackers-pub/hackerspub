import {
  ArticleMetadata,
  type ArticleMetadataProps,
} from "../islands/ArticleMetadata.tsx";
import { Excerpt } from "./Excerpt.tsx";
import { Msg, Translation } from "./Msg.tsx";

export interface ArticleExcerptProps extends ArticleMetadataProps {
  url: string | URL;
  target?: string;
  title?: string | null;
  contentHtml: string;
  emojis?: Record<string, string>;
  lang?: string;
  replyTarget?: boolean;
  sharer?: {
    url: string;
    name: string;
  };
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
      {props.sharer && (
        <p class="text-stone-500 dark:text-stone-400 mb-2">
          <Msg
            $key="article.shared"
            name={
              <a href={props.sharer.url} class="font-bold">
                {props.sharer.name}
              </a>
            }
          />
        </p>
      )}
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
      <Translation>
        {(_, language) => (
          <ArticleMetadata
            language={language}
            class="mb-2"
            authorUrl={props.authorUrl}
            authorName={props.authorName}
            authorHandle={props.authorHandle}
            authorAvatarUrl={props.authorAvatarUrl}
            published={props.published}
            editUrl={props.editUrl}
            deleteUrl={props.deleteUrl}
          />
        )}
      </Translation>
      {!props.replyTarget && (
        <a href={props.url.toString()} target={props.target}>
          <Excerpt
            lang={props.lang}
            html={props.contentHtml}
            emojis={props.emojis}
          />
          <Msg $key="article.readMore" />
        </a>
      )}
    </article>
  );
}
