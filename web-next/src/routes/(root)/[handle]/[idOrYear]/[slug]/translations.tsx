import { A, useParams } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { createSignal, onMount, Show } from "solid-js";
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
import type { translationsArticleQuery } from "./__generated__/translationsArticleQuery.graphql.ts";

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
        language
        originalLanguage
        provenance
        reviewState
        reviewedSourceRevision {
          uuid
          title
          content
        }
        translator {
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
  const env = useRelayEnvironment();
  const actingAccount = useActingAccount();
  const [data, setData] = createSignal<ManagerData | null | undefined>(
    undefined,
  );

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
            onChanged={load}
          />
        </Show>
      </Show>
    </WideContainer>
  );
}
