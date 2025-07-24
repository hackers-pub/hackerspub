import { graphql } from "relay-runtime";
import { Accessor, createSignal, Setter, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  ArticleCard_article$key,
} from "./__generated__/ArticleCard_article.graphql.ts";
import { ArticleCardInternal_article$key } from "./__generated__/ArticleCardInternal_article.graphql.ts";
import { PostSharer } from "./PostSharer.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { Trans } from "./Trans.tsx";

export interface ArticleCardProps {
  $article: ArticleCard_article$key;
}

export function ArticleCard(props: ArticleCardProps) {
  const article = createFragment(
    graphql`
      fragment ArticleCard_article on Article
        @argumentDefinitions(locale: { type: "Locale" })
      {
        ...ArticleCardInternal_article @arguments(locale: $locale)
        ...PostSharer_post
        sharedPost {
          ...ArticleCardInternal_article @arguments(locale: $locale)
        }
      }
    `,
    () => props.$article,
  );
  const [hover, setHover] = createSignal(false);

  return (
    <div
      class="flex flex-col border-b last:border-none"
      classList={{ "bg-accent": hover() }}
    >
      <Show when={article()}>
        {(article) => (
          <Show
            when={article().sharedPost}
            fallback={
              <ArticleCardInternal $article={article()} setHover={setHover} />
            }
          >
            {(sharedPost) => (
              <>
                <PostSharer $post={article()} class="p-4 pb-0" />
                <ArticleCardInternal
                  $article={sharedPost()}
                  setHover={setHover}
                />
              </>
            )}
          </Show>
        )}
      </Show>
    </div>
  );
}

interface ArticleCardInternalProps {
  $article: ArticleCardInternal_article$key;
  hover?: Accessor<boolean>;
  setHover?: Setter<boolean>;
}

function ArticleCardInternal(props: ArticleCardInternalProps) {
  const { t, i18n } = useLingui();
  const article = createFragment(
    graphql`
      fragment ArticleCardInternal_article on Article
        @argumentDefinitions(locale: { type: "Locale" })
      {
        actor {
          name
          handle
          avatarUrl
          local
          username
        }
        name
        summary
        content
        contents(language: $locale) {
          originalLanguage
          language
          title
          summary
          content
          url
        }
        language
        published
        url
        iri
      }
    `,
    () => props.$article,
  );

  return (
    <Show when={article()}>
      {(article) => (
        <>
          <div class="flex gap-4 m-4 mb-0">
            <Avatar class="size-12">
              <a
                href={article().actor.local
                  ? `/@${article().actor.username}`
                  : `/${article().actor.handle}`}
              >
                <AvatarImage src={article().actor.avatarUrl} class="size-12" />
              </a>
            </Avatar>
            <div class="flex flex-col">
              <div>
                <Show when={(article().actor.name ?? "").trim() !== ""}>
                  <a
                    innerHTML={article().actor.name ?? ""}
                    href={article().actor.local
                      ? `/@${article().actor.username}`
                      : `/${article().actor.handle}`}
                    class="font-semibold"
                  />
                  {" "}
                </Show>
                <span class="select-all text-muted-foreground">
                  {article().actor.handle}
                </span>
              </div>
              <div class="flex flex-row text-muted-foreground gap-1">
                <Timestamp value={article().published} capitalizeFirstLetter />
                <Show
                  when={article().contents != null &&
                    article().contents.length > 0 &&
                    article().contents[0].originalLanguage}
                >
                  {(originalLanguage) => (
                    <>
                      &middot;{" "}
                      <span>
                        <Trans
                          message={t`Translated from ${"LANGUAGE"}`}
                          values={{
                            LANGUAGE: () => (
                              // FIXME: There are multiple original languages,
                              //        so the link should refer to the one for
                              //        the originalLanguage.
                              <a href={article().url ?? article().iri}>
                                {new Intl.DisplayNames(i18n.locale, {
                                  type: "language",
                                }).of(originalLanguage())}
                              </a>
                            ),
                          }}
                        />
                      </span>
                    </>
                  )}
                </Show>
              </div>
            </div>
          </div>
          <Show when={article().contents?.[0]?.title ?? article().name}>
            <h1
              lang={article().contents?.[0]?.language ?? article().language ??
                undefined}
              class="text-xl font-semibold"
            >
              <a
                href={article().contents?.[0]?.url ?? article().url ??
                  article().iri}
                lang={article().contents?.[0]?.language ?? article().language ??
                  undefined}
                hreflang={article().contents?.[0]?.language ??
                  article().language ??
                  undefined}
                target={article().contents?.[0]?.url == null
                  ? "_blank"
                  : undefined}
                on:mouseover={() => props.setHover?.(true)}
                on:mouseout={() => props.setHover?.(false)}
                class="block p-4"
              >
                {article().contents?.[0]?.title ?? article().name}
              </a>
            </h1>
          </Show>
          <Show
            when={article().contents?.[0]?.summary ?? article().summary}
            fallback={
              <a
                href={article().url ?? article().iri}
                lang={article().language ?? undefined}
                hreflang={article().language ?? undefined}
                target={article().contents?.[0]?.url == null
                  ? "_blank"
                  : undefined}
                on:mouseover={() => props.setHover?.(true)}
                on:mouseout={() => props.setHover?.(false)}
                class="px-4 pb-4"
              >
                <div
                  innerHTML={article().content}
                  class="line-clamp-4 overflow-hidden"
                />
              </a>
            }
          >
            {(summary) => (
              <a
                href={article().contents?.[0]?.url ?? article().url ??
                  article().iri}
                innerHTML={summary()}
                lang={article().contents?.[0]?.language ?? article().language ??
                  undefined}
                hreflang={article().contents?.[0]?.language ??
                  article().language ??
                  undefined}
                target={article().contents?.[0]?.url == null
                  ? "_blank"
                  : undefined}
                on:mouseover={() => props.setHover?.(true)}
                on:mouseout={() => props.setHover?.(false)}
                data-llm-summary-label={t`Summarized by LLM`}
                class="prose dark:prose-invert break-words overflow-wrap px-4 pb-4 before:content-[attr(data-llm-summary-label)] before:mr-1 before:text-sm before:bg-muted before:text-muted-foreground before:p-1 before:rounded-sm before:border"
                classList={{ "before:border-transparent": !props.hover?.() }}
              />
            )}
          </Show>
          <a
            href={article().contents?.[0]?.url ?? article().url ??
              article().iri}
            hreflang={article().contents?.[0]?.language ?? article().language ??
              undefined}
            target={article().contents?.[0]?.url == null ? "_blank" : undefined}
            on:mouseover={() => props.setHover?.(true)}
            on:mouseout={() => props.setHover?.(false)}
            class="block p-4 border-t bg-muted text-center"
            classList={{
              "text-muted-foreground": !props.hover?.(),
              "text-accent-foreground": props.hover?.(),
              "border-t-muted": !props.hover?.(),
              "dark:border-t-black": props.hover?.(),
            }}
          >
            {t`Read full article`}
          </a>
        </>
      )}
    </Show>
  );
}
