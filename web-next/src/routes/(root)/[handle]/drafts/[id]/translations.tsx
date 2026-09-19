import { A, useParams } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { createSignal, onMount, Show } from "solid-js";
import { fetchQuery, graphql, type GraphQLTaggedNode } from "relay-runtime";
import { useRelayEnvironment } from "solid-relay";
import {
  type ArticleSourceRevisionView,
  ArticleTranslationManager,
  type ArticleTranslationView,
  toTranslationReviewState,
  type TranslationUuid,
} from "~/components/article-translations/ArticleTranslationManager.tsx";
import { Title } from "~/components/Title.tsx";
import { WideContainer } from "~/components/WideContainer.tsx";
import { Button } from "~/components/ui/button.tsx";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { translationsQuery } from "./__generated__/translationsQuery.graphql.ts";

const translationsQueryNode = graphql`
  query translationsQuery($username: String!, $uuid: UUID!) {
    accountByUsername(username: $username) {
      id
      username
      viewerCanActAs
    }
    articleDraft(uuid: $uuid) {
      id
      uuid
      title
      language
      currentSourceRevision {
        uuid
        title
        content
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
  canEdit: boolean;
  originalTitle: string;
  originalLanguage: string | null;
  currentSourceRevision: ArticleSourceRevisionView | null;
  translations: ArticleTranslationView[];
}

export default function ArticleDraftTranslationsPage() {
  const { t } = useLingui();
  const params = useParams();
  const env = useRelayEnvironment();
  const [data, setData] = createSignal<ManagerData | null | undefined>(
    undefined,
  );

  const load = async () => {
    const result = await fetchQuery<translationsQuery>(
      env(),
      translationsQueryNode as GraphQLTaggedNode,
      {
        username: decodeRouteParam(params.handle!).substring(1),
        uuid: params.id as TranslationUuid,
      },
    ).toPromise();
    if (result?.articleDraft == null) {
      setData(null);
      return;
    }
    const draft = result.articleDraft;
    setData({
      canEdit: result.accountByUsername?.viewerCanActAs === true,
      originalTitle: draft.title,
      originalLanguage: draft.language ?? null,
      currentSourceRevision: draft.currentSourceRevision ?? null,
      translations: draft.translationDrafts.map((translation) => ({
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
        // An unpublished draft has no published version to be behind.
        publishedReviewState: null,
        publishedBaselineSourceRevision: null,
        translatorUsername: translation.translator?.username ?? null,
      })),
    });
  };

  onMount(() => {
    void load();
  });

  return (
    <WideContainer class="px-4 py-6 sm:py-8">
      <Title>{t`Manage translations`}</Title>
      <Show
        when={data() !== undefined}
        fallback={<p class="text-sm text-muted-foreground">{t`Loading…`}</p>}
      >
        <Show
          when={data() != null && data()!.canEdit}
          fallback={
            <>
              <HttpStatusCode code={403} />
              <h1 class="text-2xl font-bold">{t`Permission denied`}</h1>
              <p class="mt-2 text-sm text-muted-foreground">
                {t`You can only manage translations for a draft you can edit.`}
              </p>
              <Button class="mt-4" onClick={() => window.history.back()}>
                {t`Go back`}
              </Button>
            </>
          }
        >
          <header class="mb-6 space-y-2">
            <A
              href={`/@${decodeRouteParam(params.handle!).substring(1)}/drafts/${params.id}`}
              class="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              {t`Back to editor`}
            </A>
            <h1 class="text-3xl font-bold tracking-tight">
              {t`Manage translations`}
            </h1>
            <p class="text-muted-foreground">{data()!.originalTitle}</p>
          </header>
          <ArticleTranslationManager
            scope={{ articleDraftId: params.id as TranslationUuid }}
            originalTitle={data()!.originalTitle}
            originalLanguage={data()!.originalLanguage}
            currentSourceRevision={data()!.currentSourceRevision}
            translations={data()!.translations}
            canPublishIndependently={false}
            onChanged={load}
          />
        </Show>
      </Show>
    </WideContainer>
  );
}
