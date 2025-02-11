import { Msg, Translation } from "./Msg.tsx";

export interface ArticleMetadataProps {
  class?: string;
  authorUrl: string;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl?: string | null;
  published: Date;
  editUrl?: string | null;
}

export function ArticleMetadata(props: ArticleMetadataProps) {
  return (
    <Translation>
      {(_, lang) => (
        <p class={`text-stone-500 dark:text-stone-400 truncate ${props.class}`}>
          <a href={props.authorUrl}>
            {props.authorAvatarUrl && (
              <img
                src={props.authorAvatarUrl}
                width={18}
                height={18}
                class="inline-block mr-2 align-text-bottom"
              />
            )}
            <strong class="text-black dark:text-white">
              {props.authorName}
            </strong>{" "}
            <span class="select-all before:content-['('] after:content-[')']">
              {props.authorHandle}
            </span>
          </a>{" "}
          &middot;{" "}
          <time datetime={props.published.toISOString()}>
            {props.published.toLocaleString(lang, {
              dateStyle: "long",
              timeStyle: "short",
            })}
          </time>
          {props.editUrl && (
            <>
              {" "} &middot;{" "}
              <a href={props.editUrl}>
                <Msg $key="article.edit" />
              </a>
            </>
          )}
        </p>
      )}
    </Translation>
  );
}
