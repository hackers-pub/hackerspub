import { normalizeLocale } from "@hackerspub/models/i18n";
import type { Toc } from "@hackerspub/models/markup";
import { Link, Meta } from "@solidjs/meta";
import {
  revalidate,
  type RouteDefinition,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { HttpHeader, HttpStatusCode } from "@solidjs/start";
import { graphql } from "relay-runtime";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createFragment, loadQuery, useRelayEnvironment } from "solid-relay";
import { CensorshipNotice } from "~/components/CensorshipNotice.tsx";
import { NoteCard } from "~/components/NoteCard.tsx";
import { NoteComposer } from "~/components/NoteComposer.tsx";
import { PostAuthorAvatar, PostAuthorLine } from "~/components/PostAuthor.tsx";
import { PostEngagementBar } from "~/components/PostEngagementBar.tsx";
import { Title } from "~/components/Title.tsx";
import { TocList } from "~/components/TocList.tsx";
import { Trans } from "~/components/Trans.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Timestamp } from "~/components/Timestamp.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { msg, plural, useLingui } from "~/lib/i18n/macro.d.ts";
import IconLoader2 from "~icons/lucide/loader-2";
import { articleOgImageUrl } from "~/lib/articleOgImage.ts";
import { useContentLinkInterceptor } from "~/lib/contentLinkInterceptor.ts";
import {
  MentionHoverCardLayer,
  useMentionHoverCards,
} from "~/lib/mentionHoverCards.tsx";
import type { SlugPageQuery } from "./__generated__/SlugPageQuery.graphql.ts";
import type { Slug_articleHeader$key } from "./__generated__/Slug_articleHeader.graphql.ts";
import type { Slug_body$key } from "./__generated__/Slug_body.graphql.ts";
import type { Slug_head$key } from "./__generated__/Slug_head.graphql.ts";
import type { Slug_languageSwitcher$key } from "./__generated__/Slug_languageSwitcher.graphql.ts";
import type { Slug_replies$key } from "./__generated__/Slug_replies.graphql.ts";
import type { Slug_viewer$key } from "./__generated__/Slug_viewer.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

const ARTICLE_PAGE_QUERY_KEY = "loadArticlePageQuery";

const SlugPageQueryDef = graphql`
  query SlugPageQuery(
    $handle: String!
    $idOrYear: String!
    $slug: String!
    $language: Locale
    $actingAccountId: ID
  ) {
    articleByYearAndSlug(
      handle: $handle
      idOrYear: $idOrYear
      slug: $slug
      actingAccountId: $actingAccountId
    ) {
      ...Slug_head @arguments(language: $language)
      ...Slug_body @arguments(
        language: $language
        actingAccountId: $actingAccountId
      )
    }
    viewer {
      locales
      ...Slug_viewer
    }
  }
`;

const loadPageQuery = routePreloadedQuery(
  (
    handle: string,
    idOrYear: string,
    slug: string,
    actingAccountId: string | null,
  ) =>
    loadQuery<SlugPageQuery>(
      useRelayEnvironment()(),
      SlugPageQueryDef,
      { handle, idOrYear, slug, language: null, actingAccountId },
    ),
  ARTICLE_PAGE_QUERY_KEY,
);

export default function ArticlePage() {
  const params = useParams();
  const handle = decodeRouteParam(params.handle!);
  const idOrYear = params.idOrYear!;
  const slug = decodeRouteParam(params.slug!);
  const { onNoteCreated } = useNoteCompose();
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();

  onMount(() => {
    onCleanup(onNoteCreated(() => {
      void revalidate(ARTICLE_PAGE_QUERY_KEY);
    }));
  });

  const data = createStablePreloadedQuery<SlugPageQuery>(
    SlugPageQueryDef,
    () => loadPageQuery(handle, idOrYear, slug, actingAccountId() ?? null),
  );

  return (
    <Show keyed when={data()}>
      {(data) => (
        <Show
          keyed
          when={data.articleByYearAndSlug}
          fallback={<HttpStatusCode code={404} />}
        >
          {(article) => (
            <>
              <ArticleMetaHead $article={article} />
              <ArticleBody
                $article={article}
                $viewer={data.viewer ?? undefined}
                viewerLocales={data.viewer?.locales}
              />
            </>
          )}
        </Show>
      )}
    </Show>
  );
}

export { ArticleBody, ArticleMetaHead };
// `ArticleTranslationPlaceholder` is also exported above (`export function ...`).

interface ArticleMetaHeadProps {
  $article: Slug_head$key;
  /**
   * Language tag to append to the article URL when computing the
   * canonical/og:url. Pass it on the `[lang]` route; omit on the index
   * route so the canonical points at the article's bare URL.
   */
  canonicalLanguage?: string;
}

function ArticleMetaHead(props: ArticleMetaHeadProps) {
  const { t } = useLingui();
  const article = createFragment(
    graphql`
      fragment Slug_head on Article
        @argumentDefinitions(
          language: { type: "Locale" }
          includeBeingTranslated: { type: "Boolean", defaultValue: false }
        )
      {
        actor {
          handle
          name
          rawName
          username
        }
        contents(
          language: $language
          includeBeingTranslated: $includeBeingTranslated
        ) {
          title
          summary
          language
          url
        }
        allContents: contents(includeBeingTranslated: true) {
          language
          beingTranslated
        }
        language
        iri
        url
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
    <Show keyed when={article()}>
      {(article) => {
        // The bare slug route doesn't pass a `language` argument to
        // `Slug_head`, so `contents` returns every completed row in
        // whatever order the resolver picks; `contents[0]` is then
        // an arbitrary translation rather than the article's source
        // text.  Find the row whose language matches the article's
        // own `language` (the canonical "original") first, and only
        // fall back to `contents[0]` if the original isn't in the
        // returned set (e.g., the `[lang]` route filtered to a
        // specific translation).
        const content = () => {
          const c = article.contents;
          if (c == null) return undefined;
          // solid-relay can republish a transiently incomplete store
          // snapshot inside `batch()` (e.g., while navigating away), where
          // individual list rows read as `undefined` even though `article()`
          // itself is still truthy.  Guard the row access with `?.` so this
          // reactive recompute doesn't throw during that window.
          return c.find((entry) => entry?.language === article.language) ??
            c[0];
        };
        const title = () => content()?.title ?? "";
        const description = () => content()?.summary ?? "";
        const currentLanguage = () =>
          content()?.language ?? article.language ?? undefined;
        const canonicalUrl = () => {
          const contentUrl = content()?.url;
          if (contentUrl != null) return contentUrl;
          const articleUrl = article.url;
          if (articleUrl == null) return null;
          if (props.canonicalLanguage == null) return articleUrl;
          try {
            const u = new URL(articleUrl);
            // Strip any trailing slashes (more than one is unlikely
            // but possible if the upstream URL ever changes), then
            // append the language as a new path segment.  The
            // language tag is `encodeURIComponent`-d to be defensive
            // against future tags that might contain reserved
            // characters; a normalized BCP 47 tag is a no-op here.
            u.pathname = `${u.pathname.replace(/\/+$/, "")}/${
              encodeURIComponent(props.canonicalLanguage)
            }`;
            return u.toString();
          } catch {
            return null;
          }
        };
        const ogImageUrl = () =>
          articleOgImageUrl(
            article.url,
            content(),
            article.language,
          );
        return (
          <>
            <Title>
              {t`${article.actor.rawName}: ${title()}`}
            </Title>
            <Show keyed when={canonicalUrl()}>
              {(href) => (
                <>
                  <Link rel="canonical" href={href} />
                  <Meta property="og:url" content={href} />
                </>
              )}
            </Show>
            <Meta property="og:title" content={title()} />
            <Meta property="og:description" content={description()} />
            <Meta property="og:type" content="article" />
            <Show keyed when={ogImageUrl()}>
              {(ogImageUrl) => (
                <>
                  <Meta property="og:image" content={ogImageUrl} />
                  <Meta property="og:image:width" content="1200" />
                  <Meta property="og:image:height" content="630" />
                </>
              )}
            </Show>
            <Show when={ogImageUrl() != null}>
              <Meta name="twitter:card" content="summary_large_image" />
            </Show>
            <Meta
              property="article:published_time"
              content={article.published}
            />
            <Meta
              property="article:modified_time"
              content={article.updated}
            />
            <Show keyed when={article.actor.rawName}>
              {(name) => <Meta property="article:author" content={name} />}
            </Show>
            <Meta
              property="article:author.username"
              content={article.actor.username}
            />
            <Meta
              name="fediverse:creator"
              content={article.actor.handle.replace(/^@/, "")}
            />
            <For each={article.hashtags}>
              {(hashtag) => (
                <Meta property="article:tag" content={hashtag.name} />
              )}
            </For>
            <Show keyed when={currentLanguage()}>
              {(language) => (
                <Meta
                  property="og:locale"
                  content={language.replaceAll("-", "_")}
                />
              )}
            </Show>
            <For
              each={article.allContents.filter(
                // In-progress placeholder rows aren't readable
                // translations yet, so listing them as
                // `og:locale:alternate` would advertise content the
                // crawler will only see as a "translating…" message.
                // The `c != null` guard mirrors `content()` above: a
                // transient solid-relay republish can surface `undefined`
                // rows mid-`batch()`.
                (c) =>
                  c != null && !c.beingTranslated &&
                  c.language !== currentLanguage(),
              )}
            >
              {(c) => (
                <Meta
                  property="og:locale:alternate"
                  content={c.language.replaceAll("-", "_")}
                />
              )}
            </For>
            <HttpHeader
              name="Link"
              value={`<${article.iri}>; rel="alternate"; type="application/activity+json"`}
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
  viewerLocales?: readonly string[] | null;
}

function ArticleBody(props: ArticleBodyProps) {
  const [proseRef, setProseRef] = createSignal<HTMLElement>();
  const mentionState = useMentionHoverCards(proseRef);
  useContentLinkInterceptor(proseRef);
  const navigate = useNavigate();
  const viewer = useViewer();
  const article = createFragment(
    graphql`
      fragment Slug_body on Article
        @argumentDefinitions(
          language: { type: "Locale" }
          includeBeingTranslated: { type: "Boolean", defaultValue: false }
          actingAccountId: { type: "ID", defaultValue: null }
        )
      {
        contents(
          language: $language
          includeBeingTranslated: $includeBeingTranslated
        ) {
          title
          content
          toc
          language
          originalLanguage
          beingTranslated
        }
        language
        tags
        censored
        actor {
          local
          username
          isViewer(actingAccountId: $actingAccountId)
        }
        publishedYear
        slug
        ...PostEngagementBar_post @arguments(
          actingAccountId: $actingAccountId
        )
        ...Slug_articleHeader
        ...Slug_languageSwitcher
        ...Slug_replies @arguments(actingAccountId: $actingAccountId)
      }
    `,
    () => props.$article,
  );

  return (
    <Show keyed when={article()}>
      {(article) => {
        // Same deterministic picker as `ArticleMetaHead` uses: prefer
        // the row whose language matches the article's own
        // (canonical original) over an arbitrary `contents[0]`,
        // falling back to the first row if the original isn't in the
        // returned set (the `[lang]` route filters to one specific
        // translation).
        const content = () => {
          const c = article.contents;
          if (c == null) return undefined;
          // solid-relay can republish a transiently incomplete store
          // snapshot inside `batch()` (e.g., while navigating away), where
          // individual list rows read as `undefined` even though `article()`
          // itself is still truthy.  Guard the row access with `?.` so this
          // reactive recompute doesn't throw during that window.
          return c.find((entry) => entry?.language === article.language) ??
            c[0];
        };
        const toc = () => (content()?.toc ?? []) as Toc[];

        return (
          <>
            <div class="mt-8 mb-4 px-4 max-w-3xl mx-auto xl:max-w-4xl 2xl:max-w-screen-lg 2xl:flex 2xl:gap-8">
              <article class="2xl:flex-1 min-w-0">
                <ArticleTitle
                  title={content()?.title}
                  language={content()?.language ?? undefined}
                />
                <ArticleHeader $article={article} />
                <Show when={article.censored}>
                  <CensorshipNotice
                    class="mt-4"
                    privileged={article.actor.isViewer || viewer.moderator()}
                  />
                </Show>
                <ArticleInlineToc
                  items={toc()}
                  hidden={content()?.beingTranslated ?? false}
                />
                <ArticleLanguageSwitcher
                  $article={article}
                  currentLanguage={content()?.language ?? undefined}
                  currentOriginalLanguage={content()?.originalLanguage}
                  viewerLocales={props.viewerLocales}
                />

                <Show when={content()?.beingTranslated}>
                  <ArticleTranslationPlaceholder
                    targetLanguage={content()?.language ?? undefined}
                  />
                </Show>

                <Show
                  keyed
                  when={!content()?.beingTranslated && content()?.content}
                >
                  {(html) => (
                    <div
                      ref={setProseRef}
                      lang={content()?.language ?? undefined}
                      class="prose dark:prose-invert mt-4 text-xl leading-8"
                      innerHTML={html}
                    />
                  )}
                </Show>
                <MentionHoverCardLayer state={mentionState} />

                <ArticleTags tags={article.tags} class="2xl:hidden mt-4" />

                {(() => {
                  // Local articles get full engagement-bar wiring;
                  // remote articles (no local `publishedYear`/`slug`)
                  // fall back to plain-text counts.
                  const base = article.actor.local &&
                      article.publishedYear != null && article.slug != null
                    ? `/@${article.actor.username}/${article.publishedYear}/${article.slug}`
                    : null;
                  return (
                    <PostEngagementBar
                      $post={article}
                      repliesHref={base == null ? null : `${base}/replies`}
                      engagementBase={base}
                      onEdit={article.actor.local &&
                          article.publishedYear != null &&
                          article.slug != null
                        ? () =>
                          navigate(
                            `/@${article.actor.username}/${article.publishedYear}/${
                              encodeURIComponent(article.slug!)
                            }/edit`,
                          )
                        : undefined}
                      class="mt-8"
                    />
                  );
                })()}
                <ArticleReplies
                  $article={article}
                  $viewer={props.$viewer}
                />
              </article>

              <ArticleAside
                toc={toc()}
                tags={article.tags}
                hidden={content()?.beingTranslated ?? false}
              />
            </div>
          </>
        );
      }}
    </Show>
  );
}

interface ArticleTitleProps {
  title?: string | null;
  language?: string;
}

function ArticleTitle(props: ArticleTitleProps) {
  // Always render the article's `<h1>`, even while a translation is
  // in progress, so the page keeps a primary heading and screen
  // readers have a stable navigation landmark.  The translating
  // placeholder card renders below this title rather than replacing
  // it.
  return (
    <Show keyed when={props.title}>
      {(title) => (
        <h1 class="text-4xl font-bold" lang={props.language}>
          {title}
        </h1>
      )}
    </Show>
  );
}

interface ArticleTranslationPlaceholderProps {
  /**
   * BCP-47 tag of the language the article is being translated *into*.
   * Used to render the localized language name in the heading via
   * `Intl.DisplayNames` and as a `lang` hint on the heading element.
   */
  targetLanguage?: string;
}

export function ArticleTranslationPlaceholder(
  props: ArticleTranslationPlaceholderProps,
) {
  const { t, i18n } = useLingui();
  const targetLanguageName = () => {
    if (props.targetLanguage == null) return null;
    try {
      return new Intl.DisplayNames(i18n.locale, { type: "language" })
        .of(props.targetLanguage) ?? props.targetLanguage;
    } catch {
      return props.targetLanguage;
    }
  };

  return (
    <div class="mt-4 border rounded-lg p-6 flex flex-col items-center gap-3 text-center">
      <IconLoader2 class="size-8 animate-spin opacity-60" aria-hidden="true" />
      <Show
        keyed
        when={targetLanguageName()}
        fallback={<p class="text-lg font-semibold">{t`Translating…`}</p>}
      >
        {(name) => (
          <p class="text-lg font-semibold">
            {t`Translating to ${name}…`}
          </p>
        )}
      </Show>
      <p class="text-sm text-muted-foreground max-w-md">
        {t`This usually takes about a minute. The page will update automatically when the translation is ready.`}
      </p>
    </div>
  );
}

interface ArticleTranslationFailureProps {
  /**
   * BCP-47 tag of the language whose translation request failed,
   * used to localize the heading.  Same shape as
   * `ArticleTranslationPlaceholder.targetLanguage`.
   */
  targetLanguage?: string;
  onRetry: () => void;
}

export function ArticleTranslationFailure(
  props: ArticleTranslationFailureProps,
) {
  const { t, i18n } = useLingui();
  const targetLanguageName = () => {
    if (props.targetLanguage == null) return null;
    try {
      return new Intl.DisplayNames(i18n.locale, { type: "language" })
        .of(props.targetLanguage) ?? props.targetLanguage;
    } catch {
      return props.targetLanguage;
    }
  };

  return (
    <div class="mt-4 border rounded-lg p-6 flex flex-col items-center gap-3 text-center">
      <Show
        keyed
        when={targetLanguageName()}
        fallback={
          <p class="text-lg font-semibold">{t`Translation request failed`}</p>
        }
      >
        {(name) => (
          <p class="text-lg font-semibold">
            {t`Translation request failed for ${name}`}
          </p>
        )}
      </Show>
      <p class="text-sm text-muted-foreground max-w-md">
        {t`We couldn't reach the translation service. Try again, or come back in a few minutes.`}
      </p>
      <Button variant="outline" onClick={() => props.onRetry()}>
        {t`Try again`}
      </Button>
    </div>
  );
}

interface ArticleHeaderProps {
  $article: Slug_articleHeader$key;
}

function ArticleHeader(props: ArticleHeaderProps) {
  const article = createFragment(
    graphql`
      fragment Slug_articleHeader on Article {
        ...PostAuthorAvatar_post
        ...PostAuthorLine_post
        published
      }
    `,
    () => props.$article,
  );

  return (
    <Show keyed when={article()}>
      {(article) => {
        return (
          <div class="flex gap-4 mt-4 items-center">
            <PostAuthorAvatar $post={article} size="large" />
            <div class="flex flex-col flex-1">
              <PostAuthorLine $post={article} />
              <div class="flex flex-row items-center text-muted-foreground gap-1 flex-wrap">
                <Timestamp
                  value={article.published}
                  capitalizeFirstLetter
                />
              </div>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

interface ArticleInlineTocProps {
  items: Toc[];
  hidden: boolean;
}

function ArticleInlineToc(props: ArticleInlineTocProps) {
  const { t } = useLingui();

  return (
    <Show when={!props.hidden && props.items.length > 0}>
      <details class="xl:hidden mt-4 bg-stone-100 dark:bg-stone-800 rounded-lg">
        <summary class="p-4 cursor-pointer font-bold text-sm uppercase text-stone-500 dark:text-stone-400">
          {t`Table of contents`}
        </summary>
        <div class="px-4 pb-4">
          <TocList items={props.items} />
        </div>
      </details>
      <nav class="hidden xl:block 2xl:hidden mt-4 p-4 bg-stone-100 dark:bg-stone-800 rounded-lg w-fit">
        <p class="font-bold text-sm leading-7 uppercase text-stone-500 dark:text-stone-400">
          {t`Table of contents`}
        </p>
        <TocList items={props.items} />
      </nav>
    </Show>
  );
}

interface ArticleLanguageSwitcherProps {
  $article: Slug_languageSwitcher$key;
  currentLanguage?: string;
  currentOriginalLanguage?: string | null;
  viewerLocales?: readonly string[] | null;
}

function ArticleLanguageSwitcher(props: ArticleLanguageSwitcherProps) {
  const { t, i18n } = useLingui();
  const article = createFragment(
    graphql`
      fragment Slug_languageSwitcher on Article {
        actor {
          username
        }
        publishedYear
        slug
        language
        allowLlmTranslation
        allContents: contents(includeBeingTranslated: true) {
          language
          url
        }
      }
    `,
    () => props.$article,
  );

  return (
    <Show keyed when={article()}>
      {(article) => {
        const postUrl = () =>
          `/@${article.actor.username}/${article.publishedYear}/${article.slug}`;
        // solid-relay can republish a transiently incomplete store
        // snapshot inside `batch()` (e.g., while navigating away),
        // surfacing `undefined` rows even though `article()` itself is
        // still truthy.  Normalize to the present rows once so every read
        // below stays guarded.
        const allContents = () => article.allContents.filter((c) => c != null);
        // Extra links for the viewer's preferred locales that aren't
        // already represented in the existing translations and aren't
        // the article's original language.  Clicking one navigates to
        // `/lang`, which auto-fires `requestArticleTranslation` from
        // `[lang].tsx` and renders the in-progress placeholder.
        //
        // Comparisons are done on the language *and* script subtags
        // (after `Intl.Locale.maximize()`) so two regional variants
        // that share both (e.g., `en-US` vs `en-GB`) collapse — the
        // existing translation already covers the viewer's locale —
        // but two variants that differ in script (e.g., `zh-CN` vs
        // `zh-TW`, which maximize to `zh-Hans-CN` vs `zh-Hant-TW`)
        // stay distinct, because Simplified and Traditional Chinese
        // are meaningfully different translation outputs and the
        // viewer should be offered a link for each.  This mirrors the
        // `requestArticleTranslation` mutation's same-language check.
        const extraLocales = () => {
          if (!article.allowLlmTranslation) return [];
          const locales = props.viewerLocales;
          if (locales == null || locales.length === 0) return [];
          const subtag = (locale: string | null | undefined) => {
            if (locale == null) return null;
            try {
              const max = new Intl.Locale(locale).maximize();
              return `${max.language}-${max.script}`;
            } catch {
              return locale;
            }
          };
          const existing = new Set(
            allContents().map((c) => subtag(c.language)),
          );
          const articleSubtag = subtag(article.language);
          const currentSubtag = subtag(props.currentLanguage);
          const seen = new Set<string>();
          // Each entry is the (normalized) locale tag we'll use as
          // both the link href segment and the display-name lookup.
          // We normalize through `normalizeLocale` (the same allow-
          // list the `[lang]` route's `matchFilters` and the
          // `requestArticleTranslation` mutation enforce) so a
          // viewer locale like `fr-CH` or `ka-GE` (valid BCP 47 but
          // outside `POSSIBLE_LOCALES`) is dropped here instead of
          // rendering a link that lands on 404.
          const result: string[] = [];
          for (const locale of locales) {
            const normalized = normalizeLocale(locale);
            if (normalized == null) continue;
            const s = subtag(normalized);
            if (s == null) continue;
            if (s === articleSubtag) continue;
            if (s === currentSubtag) continue;
            if (existing.has(s)) continue;
            if (seen.has(s)) continue;
            seen.add(s);
            result.push(normalized);
          }
          return result;
        };

        return (
          <Show
            when={allContents().length > 1 ||
              extraLocales().length > 0}
          >
            <aside class="mt-8 p-4 max-w-[80ch] border border-stone-200 dark:border-stone-700 flex flex-row gap-3 rounded-md">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                class="size-6 stroke-2 opacity-50 mt-0.5 flex-shrink-0"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="m10.5 21 5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 0 1 6-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 0 1-3.827-5.802"
                />
              </svg>
              <div>
                <Show keyed when={props.currentOriginalLanguage}>
                  {(originalLanguage) => {
                    const sourceUrl = () => {
                      const entry = allContents().find(
                        (c) => c.language === originalLanguage,
                      );
                      return entry?.url ?? postUrl();
                    };
                    return (
                      <p class="mb-4">
                        <Trans
                          message={t`Translated from ${"LANGUAGE"}`}
                          values={{
                            LANGUAGE: () => (
                              <a href={sourceUrl()}>
                                {new Intl.DisplayNames(i18n.locale, {
                                  type: "language",
                                }).of(originalLanguage)}
                              </a>
                            ),
                          }}
                        />
                      </p>
                    );
                  }}
                </Show>
                <nav class="text-stone-600 dark:text-stone-400">
                  <strong>{t`Other languages`}</strong> &rarr;{" "}
                  <For
                    each={[
                      ...allContents().filter(
                        (c) => c.language !== props.currentLanguage,
                      ).map((c) => ({
                        language: c.language,
                        // Being-translated placeholder rows have no
                        // server-assigned `url` yet; fall back to the
                        // canonical `/lang` segment so the link still
                        // points at a real route (where the placeholder
                        // UI renders) instead of an empty href.
                        href: c.url ?? `${postUrl()}/${c.language}`,
                      })),
                      ...extraLocales().map((language) => ({
                        language,
                        href: `${postUrl()}/${language}`,
                      })),
                    ]}
                  >
                    {(other, i) => (
                      <>
                        {i() > 0 && <>{" "}&middot;{" "}</>}
                        <a
                          href={other.href}
                          hreflang={other.language}
                          lang={other.language}
                          rel="alternate"
                          class="text-stone-900 dark:text-stone-100"
                        >
                          {new Intl.DisplayNames(other.language, {
                            type: "language",
                          }).of(other.language)}
                        </a>
                      </>
                    )}
                  </For>
                </nav>
              </div>
            </aside>
          </Show>
        );
      }}
    </Show>
  );
}

interface ArticleTagsProps {
  // Nullable because federated remote articles can come through without
  // a tag list at all (the articleSource-backed `tags` field on the
  // GraphQL Article type is nullable for the same reason).
  tags: readonly string[] | null | undefined;
  class?: string;
}

function ArticleTags(props: ArticleTagsProps) {
  return (
    <Show when={(props.tags?.length ?? 0) > 0}>
      <div class={`flex flex-wrap gap-1.5 ${props.class ?? ""}`}>
        <For each={props.tags ?? []}>
          {(tag) => (
            <a
              href={`/tags/${encodeURIComponent(tag)}`}
              rel="tag"
              class="bg-stone-100 dark:bg-stone-800 px-2 py-0.5 rounded-full text-sm text-stone-600 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700 transition-colors"
            >
              #{tag}
            </a>
          )}
        </For>
      </div>
    </Show>
  );
}

interface ArticleRepliesProps {
  $article: Slug_replies$key;
  $viewer?: Slug_viewer$key;
}

function ArticleReplies(props: ArticleRepliesProps) {
  const { t, i18n } = useLingui();
  const article = createFragment(
    graphql`
      fragment Slug_replies on Article
        @argumentDefinitions(actingAccountId: { type: "ID", defaultValue: null })
      {
        id
        iri
        replies {
          edges {
            node {
              ...NoteCard_note @arguments(actingAccountId: $actingAccountId)
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
    <Show keyed when={article()}>
      {(article) => {
        return (
          <div id="replies" class="my-8">
            <h2 class="text-xl font-bold mb-4">
              {i18n._(
                msg`${
                  plural(article.replies?.edges.length ?? 0, {
                    one: "# comment",
                    other: "# comments",
                  })
                }`,
              )}
            </h2>

            <Show when={viewer() != null}>
              <div class="mb-4">
                <NoteComposer
                  replyTargetId={article.id}
                  placeholder={t`Write a reply…`}
                  onSuccess={() => void revalidate(ARTICLE_PAGE_QUERY_KEY)}
                />
              </div>
            </Show>

            <Show when={viewer() == null}>
              <p class="p-4 text-sm text-muted-foreground">
                <Trans
                  message={t`If you have a fediverse account, you can reply to this article from your own instance. Search ${"ACTIVITYPUB_URI"} on your instance and reply to it.`}
                  values={{
                    ACTIVITYPUB_URI: () => (
                      <span class="select-all text-accent-foreground border-b border-b-muted-foreground border-dashed">
                        {article.iri}
                      </span>
                    ),
                  }}
                />
              </p>
            </Show>

            <Show when={article.replies?.edges.length}>
              <div class="border rounded-xl">
                <For each={article.replies?.edges}>
                  {(edge) => <NoteCard $note={edge.node} placeholderIfMuted />}
                </For>
              </div>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}

interface ArticleAsideProps {
  toc: Toc[];
  // Same nullability as the GraphQL Article.tags field — federated remote
  // articles can come through without a tag list.
  tags: readonly string[] | null | undefined;
  hidden: boolean;
}

function ArticleAside(props: ArticleAsideProps) {
  const { t } = useLingui();

  return (
    <aside class="hidden 2xl:block 2xl:w-56 2xl:flex-shrink-0">
      <div class="2xl:sticky 2xl:top-4">
        <Show when={!props.hidden && props.toc.length > 0}>
          <div>
            <p class="font-bold text-sm leading-7 uppercase text-stone-500 dark:text-stone-400">
              {t`Table of contents`}
            </p>
            <TocList items={props.toc} />
          </div>
        </Show>

        <Show when={(props.tags?.length ?? 0) > 0}>
          <div class="mt-6">
            <p class="font-bold text-sm uppercase text-stone-500 dark:text-stone-400 mb-2">
              {t`Tags`}
            </p>
            <ArticleTags tags={props.tags} />
          </div>
        </Show>
      </div>
    </aside>
  );
}
