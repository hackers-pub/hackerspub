import { normalizeContentLanguage } from "@hackerspub/models/i18n";
import { A, revalidate, useParams, useSearchParams } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { fetchQuery, graphql, type GraphQLTaggedNode } from "relay-runtime";
import { useRelayEnvironment } from "solid-relay";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import {
  type ArticleSourceRevisionView,
  ArticleTranslationManager,
  type ArticleTranslationView,
  type PublishedTranslationView,
  toTranslationReviewState,
  type TranslationUuid,
} from "~/components/article-translations/ArticleTranslationManager.tsx";
import { Title } from "~/components/Title.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { Button } from "~/components/ui/button.tsx";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import { refreshRelayQuery } from "~/lib/relayPreload.ts";
import type { translationsArticleQuery } from "./__generated__/translationsArticleQuery.graphql.ts";
import type { LangPageQuery } from "./__generated__/LangPageQuery.graphql.ts";
import type { SlugPageQuery } from "./__generated__/SlugPageQuery.graphql.ts";
import { ARTICLE_LANG_PAGE_QUERY_KEY, LangPageQueryDef } from "./[lang].tsx";
import { ARTICLE_PAGE_QUERY_KEY, SlugPageQueryDef } from "./index.tsx";

const translationsArticleQueryNode = graphql`
  query translationsArticleQuery(
    $handle: String!
    $idOrYear: String!
    $slug: String!
    $actingAccountId: ID
  ) {
    articleByYearAndSlug(
      handle: $handle
      idOrYear: $idOrYear
      slug: $slug
      actingAccountId: $actingAccountId
    ) {
      id
      sourceId
      name
      publishedYear
      slug
      viewerCanManageTranslations
      currentSourceRevision {
        uuid
        title
        content
      }
      contents {
        id
        language
        title
        rawContent
        originalLanguage
        provenance
        reviewState
        reviewedSourceRevision {
          uuid
          title
          content
        }
        translator {
          uuid
          username
        }
      }
      translationDrafts {
        uuid
        language
        title
        content
        contentHtml
        revision
        publishedRevision
        provenance
        publicationState
        reviewState
        baselineSourceRevision {
          uuid
          title
          content
        }
        translator {
          id
          username
        }
      }
    }
  }
`;

interface ManagerData {
  sourceId: TranslationUuid;
  originalTitle: string;
  originalLanguage: string | null;
  currentSourceRevision: ArticleSourceRevisionView | null;
  translations: ArticleTranslationView[];
  publishedOnlyTranslations: PublishedTranslationView[];
}

export default function ArticleTranslationsPage() {
  const { t } = useLingui();
  const params = useParams();
  const [searchParams] = useSearchParams<{ language?: string }>();
  const env = useRelayEnvironment();
  const actingAccount = useActingAccount();
  const [data, setData] = createSignal<ManagerData | null | undefined>(
    undefined,
  );
  // `?language=` comes from the article page's **Edit this translation**
  // action, but it is still URL input: canonicalize it the same way the
  // translation mutations do and ignore anything that does not resolve to a
  // supported content language.
  const initialLanguage = createMemo(() => {
    const requested = searchParams.language;
    if (typeof requested !== "string" || requested === "") return null;
    return normalizeContentLanguage(requested) ?? null;
  });

  const load = async () => {
    const result = await fetchQuery<translationsArticleQuery>(
      env(),
      translationsArticleQueryNode as GraphQLTaggedNode,
      {
        handle: decodeRouteParam(params.handle!),
        idOrYear: params.idOrYear!,
        slug: params.slug!,
        actingAccountId: actingAccount.selectedActingAccountId() ?? null,
      },
    ).toPromise();
    const article = result?.articleByYearAndSlug;
    const sourceId = article?.sourceId;
    if (
      sourceId == null ||
      article?.translationDrafts == null ||
      article.viewerCanManageTranslations !== true
    ) {
      setData(null);
      return;
    }
    const original = article.contents.find(
      (content) => content.originalLanguage == null,
    );
    // The published version of a language is tracked alongside its draft, and
    // listed on its own when there is no draft. A draft's review state does
    // not stand in for the published one: a draft created after a source edit
    // starts out current while readers still see the stale version, and an
    // outstanding notification is about that published version.
    const publishedByLanguage = new Map(
      article.contents
        .filter((content) => content.originalLanguage != null)
        .map((content) => [
          new Intl.Locale(content.language).baseName,
          content,
        ]),
    );
    const draftLanguages = new Set(
      article.translationDrafts.map(
        (translation) => new Intl.Locale(translation.language).baseName,
      ),
    );
    const publishedOnlyTranslations = [...publishedByLanguage.values()]
      .filter(
        (content) =>
          !draftLanguages.has(new Intl.Locale(content.language).baseName),
      )
      .map((content) => ({
        language: content.language,
        reviewState: toTranslationReviewState(
          content.reviewState ?? "UNKNOWN_BASELINE",
        ),
        baselineSourceRevision: content.reviewedSourceRevision ?? null,
        translatorUsername: content.translator?.username ?? null,
        automatic: content.provenance === "LLM",
        // Carried so reopening this language starts from the published text
        // and keeps its credit and provenance.
        title: content.title,
        rawContent: content.rawContent,
        provenance: content.provenance ?? null,
        translatorId: (content.translator?.uuid ??
          null) as TranslationUuid | null,
      }));
    function publishedReviewStateFor(language: string) {
      const content = publishedByLanguage.get(
        new Intl.Locale(language).baseName,
      );
      return content == null
        ? null
        : toTranslationReviewState(content.reviewState ?? "UNKNOWN_BASELINE");
    }
    setData({
      sourceId: sourceId as TranslationUuid,
      originalTitle: article.name ?? "",
      originalLanguage: original?.language ?? null,
      currentSourceRevision: article.currentSourceRevision ?? null,
      translations: article.translationDrafts.map((translation) => ({
        uuid: translation.uuid,
        language: translation.language,
        title: translation.title,
        content: translation.content,
        contentHtml: translation.contentHtml,
        revision: translation.revision,
        publishedRevision: translation.publishedRevision ?? null,
        provenance: translation.provenance,
        publicationState: translation.publicationState,
        reviewState: toTranslationReviewState(translation.reviewState),
        baselineSourceRevision: translation.baselineSourceRevision ?? null,
        publishedReviewState: publishedReviewStateFor(translation.language),
        publishedBaselineSourceRevision:
          publishedByLanguage.get(
            new Intl.Locale(translation.language).baseName,
          )?.reviewedSourceRevision ?? null,
        translatorUsername: translation.translator?.username ?? null,
      })),
      publishedOnlyTranslations,
    });
  };

  /**
   * Refreshes what readers see after a translation is published or a source
   * revision is acknowledged.
   *
   * A plain `revalidate()` is not enough on its own: solid-relay's
   * `loadQuery()` is `store-or-network`, so re-running a route loader can
   * answer from the store, and the Relay store only learns about fields the
   * mutation payload happened to select. A network-only refetch of the two
   * article route queries writes the whole reader-facing shape back, and the
   * revalidation then drops the router's cached entries so a brand-new
   * language (which no store patch could add to an existing list) is fetched
   * as well.
   */
  const refreshArticlePages = async (language: string) => {
    const variables = {
      handle: decodeRouteParam(params.handle!),
      idOrYear: params.idOrYear!,
      slug: decodeRouteParam(params.slug!),
      actingAccountId: actingAccount.selectedActingAccountId() ?? null,
    };
    await Promise.allSettled([
      refreshRelayQuery<SlugPageQuery>(env(), SlugPageQueryDef, {
        ...variables,
        language: null,
      }),
      refreshRelayQuery<LangPageQuery>(env(), LangPageQueryDef, {
        ...variables,
        language,
      }),
    ]);
    await revalidate([
      ARTICLE_PAGE_QUERY_KEY,
      ARTICLE_LANG_PAGE_QUERY_KEY,
    ]).catch((error: unknown) => {
      console.error("Failed to revalidate the article page:", error);
    });
  };

  onMount(() => {
    void load();
  });

  const articleBase = () =>
    `/@${decodeRouteParam(params.handle!).substring(1)}/${params.idOrYear}/${encodeURIComponent(params.slug!)}`;

  return (
    <WideContainer class="px-4 py-6 sm:py-8">
      <Title>{t`Manage translations`}</Title>
      <Show
        when={data() !== undefined}
        fallback={<p class="text-sm text-muted-foreground">{t`Loading…`}</p>}
      >
        <Show
          when={data() != null}
          fallback={
            <>
              <HttpStatusCode code={403} />
              <h1 class="text-2xl font-bold">{t`Permission denied`}</h1>
              <p class="mt-2 text-sm text-muted-foreground">
                {t`You can only manage translations for an article you can edit.`}
              </p>
              <Button class="mt-4" onClick={() => window.history.back()}>
                {t`Go back`}
              </Button>
            </>
          }
        >
          <header class="mb-6 space-y-2">
            <A
              href={articleBase()}
              class="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              {t`Back to article`}
            </A>
            <h1 class="text-3xl font-bold tracking-tight">
              {t`Manage translations`}
            </h1>
            <p class="text-muted-foreground">{data()!.originalTitle}</p>
          </header>
          <ArticleTranslationManager
            scope={{ sourceId: data()!.sourceId }}
            originalTitle={data()!.originalTitle}
            originalLanguage={data()!.originalLanguage}
            currentSourceRevision={data()!.currentSourceRevision}
            translations={data()!.translations}
            publishedOnlyTranslations={data()!.publishedOnlyTranslations}
            canPublishIndependently={true}
            initialLanguage={initialLanguage()}
            onChanged={load}
            onPublicChange={refreshArticlePages}
          />
        </Show>
      </Show>
    </WideContainer>
  );
}
