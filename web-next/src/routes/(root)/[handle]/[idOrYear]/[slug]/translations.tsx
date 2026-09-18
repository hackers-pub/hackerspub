import { A, useParams } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { createSignal, onMount, Show } from "solid-js";
import { fetchQuery, graphql, type GraphQLTaggedNode } from "relay-runtime";
import { useRelayEnvironment } from "solid-relay";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import {
  ArticleTranslationManager,
  type ArticleTranslationView,
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
      contents {
        language
        originalLanguage
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
        sourceChanged
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
  translations: ArticleTranslationView[];
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
    setData({
      sourceId: sourceId as TranslationUuid,
      originalTitle: article.name ?? "",
      originalLanguage: original?.language ?? null,
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
        sourceChanged: translation.sourceChanged,
        translatorUsername: translation.translator?.username ?? null,
      })),
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
            translations={data()!.translations}
            canPublishIndependently={true}
            onChanged={load}
          />
        </Show>
      </Show>
    </WideContainer>
  );
}
