import { A, useParams } from "@solidjs/router";
import { HttpStatusCode } from "@solidjs/start";
import { createSignal, onMount, Show } from "solid-js";
import { fetchQuery, graphql, type GraphQLTaggedNode } from "relay-runtime";
import { useRelayEnvironment } from "solid-relay";
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
  canEdit: boolean;
  originalTitle: string;
  originalLanguage: string | null;
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
        sourceChanged: translation.sourceChanged,
        translatorUsername: translation.translator?.username ?? null,
      })),
    });
  };

  onMount(() => {
    void load();
  });

  return (
    <WideContainer class="py-6">
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
          <div class="mb-6 flex items-center justify-between">
            <h1 class="text-2xl font-bold">{t`Manage translations`}</h1>
            <A
              href={`/@${decodeRouteParam(params.handle!).substring(1)}/drafts/${params.id}`}
            >
              <Button variant="outline">{t`Back to editor`}</Button>
            </A>
          </div>
          <ArticleTranslationManager
            scope={{ articleDraftId: params.id as TranslationUuid }}
            originalTitle={data()!.originalTitle}
            originalLanguage={data()!.originalLanguage}
            translations={data()!.translations}
            canPublishIndependently={false}
            onChanged={load}
          />
        </Show>
      </Show>
    </WideContainer>
  );
}
