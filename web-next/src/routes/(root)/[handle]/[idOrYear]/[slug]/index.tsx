import type { Toc } from "@hackerspub/models/markup";
import { Meta } from "@solidjs/meta";
import { query, type RouteDefinition, useParams } from "@solidjs/router";
import { HttpHeader, HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import {
  createFragment,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { NoteCard } from "~/components/NoteCard.tsx";
import { PostControls } from "~/components/PostControls.tsx";
import { Title } from "~/components/Title.tsx";
import { TocList } from "~/components/TocList.tsx";
import { Trans } from "~/components/Trans.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import { InternalLink } from "~/components/InternalLink.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { SlugPageQuery } from "./__generated__/SlugPageQuery.graphql.ts";
import type { Slug_body$key } from "./__generated__/Slug_body.graphql.ts";
import type { Slug_head$key } from "./__generated__/Slug_head.graphql.ts";
import type { Slug_viewer$key } from "./__generated__/Slug_viewer.graphql.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
  preload(args) {
    const handle = args.params.handle!;
    const idOrYear = args.params.idOrYear!;
    const slug = args.params.slug!;
    void loadPageQuery(handle, idOrYear, slug);
  },
} satisfies RouteDefinition;

const SlugPageQueryDef = graphql`
  query SlugPageQuery(
    $handle: String!
    $idOrYear: String!
    $slug: String!
  ) {
    articleByYearAndSlug(
      handle: $handle
      idOrYear: $idOrYear
      slug: $slug
    ) {
      ...Slug_head
      ...Slug_body
    }
    viewer {
      ...Slug_viewer
    }
  }
`;

const loadPageQuery = query(
  (handle: string, idOrYear: string, slug: string) =>
    loadQuery<SlugPageQuery>(
      useRelayEnvironment()(),
      SlugPageQueryDef,
      { handle, idOrYear, slug },
    ),
  "loadArticlePageQuery",
);

export default function ArticlePage() {
  const params = useParams();
  const handle = params.handle!;
  const idOrYear = params.idOrYear!;
  const slug = params.slug!;

  const data = createPreloadedQuery<SlugPageQuery>(
    SlugPageQueryDef,
    () => loadPageQuery(handle, idOrYear, slug),
  );

  return (
    <Show when={data()}>
      {(data) => (
        <Show
          when={data().articleByYearAndSlug}
          fallback={<HttpStatusCode code={404} />}
        >
          {(article) => (
            <>
              <ArticleMetaHead $article={article()} />
              <ArticleBody
                $article={article()}
                $viewer={data().viewer ?? undefined}
              />
            </>
          )}
        </Show>
      )}
    </Show>
  );
}

interface ArticleMetaHeadProps {
  $article: Slug_head$key;
}

function ArticleMetaHead(props: ArticleMetaHeadProps) {
  const { t } = useLingui();
  const article = createFragment(
    graphql`
      fragment Slug_head on Article {
        actor {
          handle
          name
          username
        }
        contents {
          title
          summary
          language
        }
        language
        iri
        published
        updated
        hashtags {
          name
        }
      }
    `,
    () => props.$article,
  );

  return (
    <Show when={article()}>
      {(article) => {
        const content = () => article().contents?.[0];
        const title = () => content()?.title ?? "";
        const description = () => content()?.summary ?? "";
        return (
          <>
            <Title>
              {t`${article().actor.name}: ${title()}`}
            </Title>
            <Meta property="og:title" content={title()} />
            <Meta property="og:description" content={description()} />
            <Meta property="og:type" content="article" />
            <Meta
              property="article:published_time"
              content={article().published}
            />
            <Meta
              property="article:modified_time"
              content={article().updated}
            />
            <Show when={article().actor.name}>
              {(name) => <Meta property="article:author" content={name()} />}
            </Show>
            <Meta
              property="article:author.username"
              content={article().actor.username}
            />
            <Meta
              name="fediverse:creator"
              content={article().actor.handle.replace(/^@/, "")}
            />
            <For each={article().hashtags}>
              {(hashtag) => (
                <Meta property="article:tag" content={hashtag.name} />
              )}
            </For>
            <Show when={content()?.language ?? article().language}>
              {(language) => <Meta property="og:locale" content={language()} />}
            </Show>
            <HttpHeader
              name="Link"
              value={`<${article().iri}>; rel="alternate"; type="application/activity+json"`}
            />
          </>
        );
      }}
    </Show>
  );
}

interface ArticleBodyProps {
  $article: Slug_body$key;
  $viewer?: Slug_viewer$key;
}

function ArticleBody(props: ArticleBodyProps) {
  const { t } = useLingui();

  const article = createFragment(
    graphql`
      fragment Slug_body on Article {
        iri
        url
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
        contents {
          title
          content
          toc
          language
          originalLanguage
          summary
          beingTranslated
          url
        }
        allowLlmTranslation
        publishedYear
        slug
        tags
        published
        ...PostControls_post
        replyTarget {
          ...NoteCard_note
        }
        replies {
          edges {
            node {
              ...NoteCard_note
            }
          }
        }
      }
    `,
    () => props.$article,
  );

  const viewer = createFragment(
    graphql`
      fragment Slug_viewer on Account {
        id
      }
    `,
    () => props.$viewer,
  );

  return (
    <Show when={article()}>
      {(article) => {
        const content = () => article().contents?.[0];
        const toc = () => (content()?.toc ?? []) as Toc[];
        const postUrl = () =>
          `/@${article().actor.username}/${article().publishedYear}/${article().slug}`;

        return (
          <>
            <article class="my-4">
              <Show when={content()?.beingTranslated}>
                <h1 class="text-4xl font-bold">
                  {t`Translating...`}
                </h1>
              </Show>
              <Show when={!content()?.beingTranslated}>
                <h1
                  class="text-4xl font-bold"
                  lang={content()?.language ??
                    article().contents?.[0]?.language ?? undefined}
                >
                  {content()?.title}
                </h1>
              </Show>

              {/* Author metadata */}
              <div class="flex gap-4 mt-4 items-center">
                <Avatar class="size-12">
                  <InternalLink
                    href={article().actor.url ?? article().actor.iri}
                    internalHref={article().actor.local
                      ? `/@${article().actor.username}`
                      : `/${article().actor.handle}`}
                  >
                    <AvatarImage
                      src={article().actor.avatarUrl}
                      class="size-12"
                    />
                    <AvatarFallback class="size-12">
                      {article().actor.avatarInitials}
                    </AvatarFallback>
                  </InternalLink>
                </Avatar>
                <div class="flex flex-col">
                  <Show when={(article().actor.name ?? "").trim() !== ""}>
                    <InternalLink
                      innerHTML={article().actor.name ?? ""}
                      href={article().actor.url ?? article().actor.iri}
                      internalHref={article().actor.local
                        ? `/@${article().actor.username}`
                        : `/${article().actor.handle}`}
                      class="font-semibold"
                    />
                  </Show>
                  <div class="flex flex-row items-center text-muted-foreground gap-1">
                    <span class="select-all">
                      {article().actor.handle}
                    </span>
                    <span>&middot;</span>
                    <Timestamp
                      value={article().published}
                      capitalizeFirstLetter
                    />
                  </div>
                </div>
              </div>

              {/* Table of Contents */}
              <Show when={!content()?.beingTranslated && toc().length > 0}>
                <nav class="
                    mt-4 p-4 bg-stone-100 dark:bg-stone-800 w-fit xl:max-w-md
                    xl:absolute right-[calc((100%-1280px)/2)]
                  ">
                  <p class="font-bold text-sm leading-7 uppercase text-stone-500 dark:text-stone-400">
                    {t`Table of contents`}
                  </p>
                  <TocList items={toc()} />
                </nav>
              </Show>

              {/* Language switcher */}
              <Show
                when={article().contents != null &&
                  article().contents.length > 1}
              >
                <aside class="mt-8 p-4 max-w-[80ch] border border-stone-200 dark:border-stone-700 flex flex-row gap-4">
                  <div>
                    <Show when={content()?.originalLanguage}>
                      {(originalLanguage) => (
                        <p class="mb-4">
                          <Trans
                            message={t`Translated from ${"LANGUAGE"}`}
                            values={{
                              LANGUAGE: () => (
                                <a href={postUrl()}>
                                  {new Intl.DisplayNames("en", {
                                    type: "language",
                                  }).of(originalLanguage())}
                                </a>
                              ),
                            }}
                          />
                        </p>
                      )}
                    </Show>
                    <nav class="text-stone-600 dark:text-stone-400">
                      <For
                        each={article().contents.filter(
                          (c) => c.language !== content()?.language,
                        )}
                      >
                        {(otherContent, i) => (
                          <>
                            {i() > 0 && <>{" "}&middot;{" "}</>}
                            <a
                              href={otherContent.url}
                              hreflang={otherContent.language}
                              lang={otherContent.language}
                              rel="alternate"
                              class="text-stone-900 dark:text-stone-100"
                            >
                              {new Intl.DisplayNames(otherContent.language, {
                                type: "language",
                              }).of(otherContent.language)}
                            </a>
                          </>
                        )}
                      </For>
                    </nav>
                  </div>
                </aside>
              </Show>

              {/* Article content */}
              <Show when={!content()?.beingTranslated && content()?.content}>
                {(html) => (
                  <div
                    lang={content()?.language ?? undefined}
                    class="prose dark:prose-invert mt-4 text-xl leading-8"
                    innerHTML={html()}
                  />
                )}
              </Show>

              {/* Post controls */}
              <PostControls
                $post={article()}
                class="mt-8"
              />
            </article>

            {/* Comments section */}
            <div id="replies" class="my-4">
              <Show when={article().replies?.edges.length}>
                <h2 class="text-xl font-bold mb-4">
                  {t`Comments (${article().replies?.edges.length ?? 0})`}
                </h2>
                <div class="border rounded-xl max-w-prose mx-auto">
                  <For each={article().replies?.edges}>
                    {(edge) => <NoteCard $note={edge.node} />}
                  </For>
                </div>
              </Show>
              <Show when={viewer() == null}>
                <p class="p-4 text-sm text-muted-foreground">
                  <Trans
                    message={t`If you have a fediverse account, you can reply to this article from your own instance. Search ${"ACTIVITYPUB_URI"} on your instance and reply to it.`}
                    values={{
                      ACTIVITYPUB_URI: () => (
                        <span class="select-all text-accent-foreground border-b border-b-muted-foreground border-dashed">
                          {article().iri}
                        </span>
                      ),
                    }}
                  />
                </p>
              </Show>
            </div>
          </>
        );
      }}
    </Show>
  );
}
