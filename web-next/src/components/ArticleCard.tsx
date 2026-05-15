import { graphql } from "relay-runtime";
import { Accessor, createSignal, Setter, Show } from "solid-js";
import { createFragment } from "solid-relay";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
import {
  ArticleCard_article$key,
} from "./__generated__/ArticleCard_article.graphql.ts";
import { ArticleCardInternal_article$key } from "./__generated__/ArticleCardInternal_article.graphql.ts";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { ActorHoverCard } from "./ActorHoverCard.tsx";
import { InternalLink } from "./InternalLink.tsx";
import { PostActionMenu } from "./PostActionMenu.tsx";
import { PostEngagementBar } from "./PostEngagementBar.tsx";
import { PostSharer } from "./PostSharer.tsx";
import { Timestamp } from "./Timestamp.tsx";
import { Trans } from "./Trans.tsx";

export interface ArticleCardProps {
  $article: ArticleCard_article$key;
  connections?: string[];
  bookmarkListConnections?: string[];
  pinConnections?: string[];
}

export function ArticleCard(props: ArticleCardProps) {
  const article = createFragment(
    graphql`
      fragment ArticleCard_article on Article
        @argumentDefinitions(locale: { type: "Locale" })
      {
        uuid
        actor {
          local
          username
          handle
        }
        publishedYear
        slug
        ...ArticleCardInternal_article @arguments(locale: $locale)
        ...PostEngagementBar_post
        ...PostSharer_post
        sharedPost {
          ... on Article {
            uuid
            actor {
              local
              username
              handle
            }
            publishedYear
            slug
          }
          ...ArticleCardInternal_article @arguments(locale: $locale)
          ...PostEngagementBar_post
        }
      }
    `,
    () => props.$article,
  );
  const [hover, setHover] = createSignal(false);
  const [articleRef, setArticleRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(articleRef);

  return (
    <article
      ref={setArticleRef}
      class="group flex flex-col border-b transition-colors last:border-none"
      classList={{ "bg-muted/40": hover() }}
    >
      <Show keyed when={article()}>
        {(article) => (
          <Show
            keyed
            when={article.sharedPost}
            fallback={
              <>
                <ArticleCardInternal
                  $article={article}
                  setHover={setHover}
                  connections={props.connections}
                  pinConnections={props.pinConnections}
                />
                {(() => {
                  // Prefer the pretty `/@user/{year}/{slug}` permalink
                  // when the article exposes both `publishedYear` and
                  // `slug`.  Otherwise (remote articles, or local
                  // articles that haven't materialised those columns
                  // yet) fall back to the UUID-based `[noteId]` route
                  // — `actorByHandle.postByUuid` resolves any post type
                  // on any actor, and `[noteId]/index.tsx` accepts
                  // articles so `/replies` works there too.
                  const prettyBase = article.actor.local &&
                      article.publishedYear != null && article.slug != null
                    ? `/@${article.actor.username}/${article.publishedYear}/${article.slug}`
                    : null;
                  const engagementBase = prettyBase ??
                    `/${
                      encodeHandleSegment(article.actor.handle)
                    }/${article.uuid}`;
                  return (
                    <PostEngagementBar
                      $post={article}
                      repliesHref={`${engagementBase}/replies`}
                      engagementBase={engagementBase}
                      bookmarkListConnections={props.bookmarkListConnections}
                      class="mx-4 mb-2"
                    />
                  );
                })()}
              </>
            }
          >
            {(sharedPost) => (
              <>
                <PostSharer $post={article} class="p-4 pb-0" />
                <ArticleCardInternal
                  $article={sharedPost}
                  setHover={setHover}
                  connections={props.connections}
                  pinConnections={props.pinConnections}
                />
                {(() => {
                  // Mirror the standalone-article branch: prefer the
                  // pretty `/@user/{year}/{slug}` permalink when it's
                  // available; otherwise fall back to a UUID-based
                  // `[noteId]` engagement base.  Both the count routes
                  // and `/replies` accept articles on the UUID path.
                  const prettyBase = sharedPost.actor?.local &&
                      sharedPost.publishedYear != null &&
                      sharedPost.slug != null
                    ? `/@${sharedPost.actor.username}/${sharedPost.publishedYear}/${sharedPost.slug}`
                    : null;
                  const engagementBase = prettyBase ??
                    (sharedPost.actor != null && sharedPost.uuid != null
                      ? `/${
                        encodeHandleSegment(sharedPost.actor.handle)
                      }/${sharedPost.uuid}`
                      : null);
                  return (
                    <PostEngagementBar
                      $post={sharedPost}
                      repliesHref={engagementBase == null
                        ? null
                        : `${engagementBase}/replies`}
                      engagementBase={engagementBase}
                      bookmarkListConnections={props.bookmarkListConnections}
                      class="mx-4 mb-2"
                    />
                  );
                })()}
              </>
            )}
          </Show>
        )}
      </Show>
      <MentionHoverCardLayer state={mentionState} />
    </article>
  );
}

interface ArticleCardInternalProps {
  $article: ArticleCardInternal_article$key;
  hover?: Accessor<boolean>;
  setHover?: Setter<boolean>;
  connections?: string[];
  pinConnections?: string[];
}

function ArticleCardInternal(props: ArticleCardInternalProps) {
  const { t, i18n } = useLingui();
  const article = createFragment(
    graphql`
      fragment ArticleCardInternal_article on Article
        @argumentDefinitions(locale: { type: "Locale" })
      {
        __id
        ...PostActionMenu_post
        actor {
          name
          handle
          avatarUrl
          avatarInitials
          local
          username
          url
          iri
        }
        name
        summary
        excerptHtml(maxChars: 800)
        contents(language: $locale) {
          originalLanguage
          language
          title
          summary
          url
        }
        language
        published
        publishedYear
        slug
        url
        iri
      }
    `,
    () => props.$article,
  );

  return (
    <Show keyed when={article()}>
      {(article) => (
        <>
          <div class="m-4 mb-0 flex gap-3 sm:gap-4">
            <ActorHoverCard handle={article.actor.handle} class="shrink-0">
              <Avatar class="size-12">
                <InternalLink
                  href={article.actor.url ?? article.actor.iri}
                  internalHref={article.actor.local
                    ? `/@${article.actor.username}`
                    : `/${article.actor.handle}`}
                >
                  <AvatarImage
                    src={article.actor.avatarUrl}
                    class="size-12"
                  />
                  <AvatarFallback class="size-12">
                    {article.actor.avatarInitials}
                  </AvatarFallback>
                </InternalLink>
              </Avatar>
            </ActorHoverCard>
            <div class="flex min-w-0 flex-col">
              <ActorHoverCard
                handle={article.actor.handle}
                class="flex min-w-0 items-baseline gap-x-1"
              >
                <Show when={(article.actor.name ?? "").trim() !== ""}>
                  <InternalLink
                    innerHTML={article.actor.name ?? ""}
                    href={article.actor.url ?? article.actor.iri}
                    internalHref={article.actor.local
                      ? `/@${article.actor.username}`
                      : `/${article.actor.handle}`}
                    class="shrink-0 font-semibold"
                  />
                </Show>
                <span
                  class="min-w-0 truncate select-all text-muted-foreground"
                  title={article.actor.handle}
                >
                  {article.actor.handle}
                </span>
              </ActorHoverCard>
              <div class="flex flex-row items-center gap-1 text-sm text-muted-foreground/70">
                <Timestamp value={article.published} capitalizeFirstLetter />
                <PostActionMenu
                  $post={article}
                  connections={props.connections}
                  pinConnections={props.pinConnections}
                />
                <Show
                  keyed
                  when={article.contents != null &&
                    article.contents.length > 0 &&
                    article.contents[0].originalLanguage}
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
                              <a href={article.url ?? article.iri}>
                                {new Intl.DisplayNames(i18n.locale, {
                                  type: "language",
                                }).of(originalLanguage)}
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
          <Show when={article.contents?.[0]?.title ?? article.name}>
            <h1
              lang={article.contents?.[0]?.language ?? article.language ??
                undefined}
              class="text-xl font-semibold leading-snug"
            >
              <Show
                when={article.actor.local}
                fallback={
                  <a
                    href={article.contents?.[0]?.url ?? article.url ??
                      article.iri}
                    lang={article.contents?.[0]?.language ??
                      article.language ?? undefined}
                    hreflang={article.contents?.[0]?.language ??
                      article.language ?? undefined}
                    target="_blank"
                    on:mouseover={() => props.setHover?.(true)}
                    on:mouseout={() => props.setHover?.(false)}
                    class="block p-4"
                  >
                    {article.contents?.[0]?.title ?? article.name}
                  </a>
                }
              >
                <InternalLink
                  href={article.contents?.[0]?.url ?? article.url ??
                    article.iri}
                  internalHref={`/@${article.actor.username}/${article.publishedYear}/${article.slug}`}
                  lang={article.contents?.[0]?.language ??
                    article.language ?? undefined}
                  hreflang={article.contents?.[0]?.language ??
                    article.language ?? undefined}
                  on:mouseover={() => props.setHover?.(true)}
                  on:mouseout={() => props.setHover?.(false)}
                  class="block p-4"
                >
                  {article.contents?.[0]?.title ?? article.name}
                </InternalLink>
              </Show>
            </h1>
          </Show>
          <Show
            keyed
            when={article.contents?.[0]?.summary ?? article.summary}
            fallback={
              <Show
                when={article.actor.local}
                fallback={
                  <a
                    href={article.url ?? article.iri}
                    lang={article.language ?? undefined}
                    hreflang={article.language ?? undefined}
                    target="_blank"
                    on:mouseover={() => props.setHover?.(true)}
                    on:mouseout={() => props.setHover?.(false)}
                    class="px-4 pb-4"
                  >
                    <div
                      innerHTML={article.excerptHtml}
                      class="line-clamp-4 overflow-hidden"
                    />
                  </a>
                }
              >
                <InternalLink
                  href={article.url ?? article.iri}
                  internalHref={`/@${article.actor.username}/${article.publishedYear}/${article.slug}`}
                  lang={article.language ?? undefined}
                  hreflang={article.language ?? undefined}
                  on:mouseover={() => props.setHover?.(true)}
                  on:mouseout={() => props.setHover?.(false)}
                  class="px-4 pb-4"
                >
                  <div
                    innerHTML={article.excerptHtml}
                    class="line-clamp-4 overflow-hidden"
                  />
                </InternalLink>
              </Show>
            }
          >
            {(summary) => (
              <Show
                when={article.actor.local}
                fallback={
                  <a
                    href={article.contents?.[0]?.url ?? article.url ??
                      article.iri}
                    innerHTML={summary}
                    lang={article.contents?.[0]?.language ??
                      article.language ?? undefined}
                    hreflang={article.contents?.[0]?.language ??
                      article.language ?? undefined}
                    target="_blank"
                    on:mouseover={() => props.setHover?.(true)}
                    on:mouseout={() => props.setHover?.(false)}
                    data-llm-summary-label={t`Summarized by LLM`}
                    class="prose dark:prose-invert break-words overflow-wrap px-4 pb-4 before:content-[attr(data-llm-summary-label)] before:mr-1 before:text-sm before:bg-muted before:text-muted-foreground before:p-1 before:rounded-sm before:border"
                    classList={{
                      "before:border-transparent": !props.hover?.(),
                    }}
                  />
                }
              >
                <InternalLink
                  href={article.contents?.[0]?.url ?? article.url ??
                    article.iri}
                  internalHref={`/@${article.actor.username}/${article.publishedYear}/${article.slug}`}
                  innerHTML={summary}
                  lang={article.contents?.[0]?.language ??
                    article.language ?? undefined}
                  hreflang={article.contents?.[0]?.language ??
                    article.language ?? undefined}
                  on:mouseover={() => props.setHover?.(true)}
                  on:mouseout={() => props.setHover?.(false)}
                  data-llm-summary-label={t`Summarized by LLM`}
                  class="prose dark:prose-invert break-words overflow-wrap px-4 pb-4 before:content-[attr(data-llm-summary-label)] before:mr-1 before:text-sm before:bg-muted before:text-muted-foreground before:p-1 before:rounded-sm before:border"
                  classList={{
                    "before:border-transparent": !props.hover?.(),
                  }}
                />
              </Show>
            )}
          </Show>
          <Show
            when={article.actor.local}
            fallback={
              <a
                href={article.contents?.[0]?.url ?? article.url ??
                  article.iri}
                hreflang={article.contents?.[0]?.language ??
                  article.language ?? undefined}
                target="_blank"
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
            }
          >
            <InternalLink
              href={article.contents?.[0]?.url ?? article.url ??
                article.iri}
              internalHref={`/@${article.actor.username}/${article.publishedYear}/${article.slug}`}
              hreflang={article.contents?.[0]?.language ??
                article.language ?? undefined}
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
            </InternalLink>
          </Show>
        </>
      )}
    </Show>
  );
}
