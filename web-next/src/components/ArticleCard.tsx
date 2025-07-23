import { graphql } from "relay-runtime";
import { createSignal, Show } from "solid-js";
import { createFragment } from "solid-relay";
import { Avatar, AvatarImage } from "~/components/ui/avatar.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  ArticleCard_article$data,
  ArticleCard_article$key,
} from "./__generated__/ArticleCard_article.graphql.ts";
import { Timestamp } from "./Timestamp.tsx";
import { Trans } from "./Trans.tsx";

export interface ArticleCardProps {
  $article: ArticleCard_article$key;
}

export function ArticleCard(props: ArticleCardProps) {
  const article = createFragment(
    graphql`
      fragment ArticleCard_article on Article
        @argumentDefinitions(
          locale: { type: "Locale" },
        )
      {
        actor {
          name
          handle
          avatarUrl
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
        sharedPost {
          __typename
          actor {
            name
            handle
            avatarUrl
          }
          name
          summary
          content
          ... on Article {
            contents(language: $locale) {
              originalLanguage
              language
              title
              summary
              content
              url
            }
          }
          language
          published
          url
          iri
        }
      }
    `,
    () => props.$article,
  );

  return (
    <Show when={article()}>
      {(article) => (
        <Show
          when={article().sharedPost}
          fallback={
            <ArticleCardInternal
              actor={article().actor}
              published={article().published}
              name={article().name}
              summary={article().summary}
              content={article().content}
              contents={article().contents}
              language={article().language}
              url={article().url}
              iri={article().iri}
            />
          }
        >
          {(sharedPost) => (
            <ArticleCardInternal
              actor={sharedPost().actor}
              published={sharedPost().published}
              name={sharedPost().name}
              summary={sharedPost().summary}
              content={sharedPost().content}
              contents={sharedPost().contents}
              language={sharedPost().language}
              url={sharedPost().url}
              iri={sharedPost().iri}
            />
          )}
        </Show>
      )}
    </Show>
  );
}

interface ArticleCardInternalProps {
  actor: {
    name: string | null | undefined;
    handle: string;
    avatarUrl: string;
  };
  published: string | Date;
  name: string | null | undefined;
  summary: string | null | undefined;
  content: string;
  language: string | null | undefined;
  contents: ArticleCard_article$data["contents"] | null | undefined;
  url: string | null | undefined;
  iri: string;
}

function ArticleCardInternal(props: ArticleCardInternalProps) {
  const { t, i18n } = useLingui();
  const [hover, setHover] = createSignal(false);
  return (
    <div
      class="flex flex-col border-b last:border-none"
      classList={{ "bg-accent": hover() }}
    >
      <div class="flex gap-4 m-4 mb-0">
        <Avatar class="size-12">
          <AvatarImage src={props.actor.avatarUrl} class="size-12" />
        </Avatar>
        <div class="flex flex-col">
          <div>
            <Show when={(props.actor.name ?? "").trim() !== ""}>
              <span class="font-semibold">{props.actor.name}</span>
              {" "}
            </Show>
            <span class="select-all text-muted-foreground">
              {props.actor.handle}
            </span>
          </div>
          <div class="flex flex-row text-muted-foreground gap-1">
            <Timestamp value={props.published} capitalizeFirstLetter />
            <Show
              when={props.contents != null && props.contents.length > 0 &&
                props.contents[0].originalLanguage}
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
                          <a href={props.url ?? props.iri}>
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
      <Show when={props.contents?.[0]?.title ?? props.name}>
        <h1
          lang={props.contents?.[0]?.language ?? props.language ?? undefined}
          class="text-xl font-semibold"
        >
          <a
            href={props.contents?.[0]?.url ?? props.url ?? props.iri}
            lang={props.contents?.[0]?.language ?? props.language ?? undefined}
            hreflang={props.contents?.[0]?.language ?? props.language ??
              undefined}
            target={props.contents?.[0]?.url == null ? "_blank" : undefined}
            on:mouseover={() => setHover(true)}
            on:mouseout={() => setHover(false)}
            class="block p-4"
          >
            {props.contents?.[0]?.title ?? props.name}
          </a>
        </h1>
      </Show>
      <Show
        when={props.contents?.[0]?.summary ?? props.summary}
        fallback={
          <a
            href={props.url ?? props.iri}
            lang={props.language ?? undefined}
            hreflang={props.language ?? undefined}
            target={props.contents?.[0]?.url == null ? "_blank" : undefined}
            on:mouseover={() => setHover(true)}
            on:mouseout={() => setHover(false)}
            class="px-4 pb-4"
          >
            <div
              innerHTML={props.content}
              class="line-clamp-4 overflow-hidden"
            />
          </a>
        }
      >
        {(summary) => (
          <a
            href={props.contents?.[0]?.url ?? props.url ?? props.iri}
            innerHTML={summary()}
            lang={props.contents?.[0]?.language ?? props.language ?? undefined}
            hreflang={props.contents?.[0]?.language ?? props.language ??
              undefined}
            target={props.contents?.[0]?.url == null ? "_blank" : undefined}
            on:mouseover={() => setHover(true)}
            on:mouseout={() => setHover(false)}
            data-llm-summary-label={t`Summarized by LLM`}
            class="prose dark:prose-invert px-4 pb-4 before:content-[attr(data-llm-summary-label)] before:mr-1 before:text-sm before:bg-muted before:text-muted-foreground before:p-1 before:rounded-sm before:border"
            classList={{ "before:border-transparent": !hover() }}
          />
        )}
      </Show>
      <a
        href={props.contents?.[0]?.url ?? props.url ?? props.iri}
        hreflang={props.contents?.[0]?.language ?? props.language ?? undefined}
        target={props.contents?.[0]?.url == null ? "_blank" : undefined}
        on:mouseover={() => setHover(true)}
        on:mouseout={() => setHover(false)}
        class="block p-4 border-t bg-muted text-center"
        classList={{
          "text-muted-foreground": !hover(),
          "text-accent-foreground": hover(),
          "border-t-muted": !hover(),
          "dark:border-t-black": hover(),
        }}
      >
        {t`Read full article`}
      </a>
    </div>
  );
}
