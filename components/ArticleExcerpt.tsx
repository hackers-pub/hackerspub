import { escape } from "@std/html/entities";
import {
  ArticleMetadata,
  type ArticleMetadataProps,
} from "../islands/ArticleMetadata.tsx";
import { Link } from "../islands/Link.tsx";
import { PostControls } from "../islands/PostControls.tsx";
import { renderCustomEmojis } from "../models/emoji.ts";
import { Excerpt } from "./Excerpt.tsx";
import { Msg, Translation } from "./Msg.tsx";

export type ArticleExcerptProps = Omit<ArticleMetadataProps, "language"> & {
  url: string | URL;
  target?: string;
  title?: string | null;
  contentHtml: string;
  emojis?: Record<string, string>;
  lang?: string;
  replier?: {
    url: string;
    internalUrl?: string;
    name: string;
    emojis: Record<string, string>;
    avatarUrl: string;
  };
  sharer?: {
    url: string;
    internalUrl?: string;
    name: string;
    emojis: Record<string, string>;
    avatarUrl: string;
  };
  controls?: {
    repliesCount: number;
    replyUrl?: string;
    sharesCount: number;
    shared: boolean;
    shareUrl?: string;
    unshareUrl?: string;
    sharedPeopleUrl?: string;
  };
};

export function ArticleExcerpt(props: ArticleExcerptProps) {
  return (
    <Translation>
      {(_, language) => (
        <article
          class={`
            mt-5 p-5 bg-stone-100 dark:bg-stone-800
            ${props.class}
          `}
        >
          {props.replier && (
            <p class="text-stone-500 dark:text-stone-400 mb-2">
              <Msg
                $key="article.replied"
                name={
                  <Link
                    href={props.replier.url}
                    internalHref={props.replier.internalUrl}
                    class="font-bold"
                  >
                    <img
                      src={props.replier.avatarUrl}
                      width={16}
                      height={16}
                      class="inline-block mr-1 mt-[2px] align-text-top"
                    />
                    <strong
                      dangerouslySetInnerHTML={{
                        __html: renderCustomEmojis(
                          escape(props.replier.name),
                          props.replier.emojis,
                        ),
                      }}
                    />
                  </Link>
                }
              />
            </p>
          )}
          {props.sharer && (
            <p class="text-stone-500 dark:text-stone-400 mb-2">
              <Msg
                $key="article.shared"
                name={
                  <Link
                    href={props.sharer.url}
                    internalHref={props.sharer.internalUrl}
                    class="font-bold"
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
            </p>
          )}
          {props.title &&
            (
              <h1
                class="text-3xl font-bold mb-2"
                lang={props.lang}
              >
                <a href={props.url.toString()} target={props.target}>
                  {props.title}
                </a>
              </h1>
            )}
          <ArticleMetadata
            language={language}
            class="mt-4 mb-2"
            authorUrl={props.authorUrl}
            authorInternalUrl={props.authorInternalUrl}
            authorName={props.authorName}
            authorHandle={props.authorHandle}
            authorAvatarUrl={props.authorAvatarUrl}
            published={props.published}
            editUrl={props.editUrl}
            deleteUrl={props.deleteUrl}
          />
          <a href={props.url.toString()} target={props.target}>
            <Excerpt
              lang={props.lang}
              html={props.contentHtml}
              emojis={props.emojis}
            />
            <Msg $key="article.readMore" />
          </a>
          {props.controls && (
            <PostControls
              language={language}
              class="mt-4"
              replies={props.controls.repliesCount}
              replyUrl={props.controls.replyUrl}
              shares={props.controls.sharesCount}
              shared={props.controls.shared}
              shareUrl={props.controls.shareUrl}
              unshareUrl={props.controls.unshareUrl}
              sharedPeopleUrl={props.controls.sharedPeopleUrl}
              deleteUrl={props.deleteUrl ?? undefined}
              deleteMethod="post"
            />
          )}
        </article>
      )}
    </Translation>
  );
}
