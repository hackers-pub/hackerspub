import {
  revalidate,
  type RouteDefinition,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { HttpStatusCode } from "@solidjs/start";
import { fetchQuery, graphql } from "relay-runtime";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { debounce } from "es-toolkit";
import {
  createFragment,
  createMutation,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import IconLoader2 from "~icons/lucide/loader-2";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { TagInput } from "~/components/TagInput.tsx";
import { Title } from "~/components/Title.tsx";
import { Button } from "~/components/ui/button.tsx";
import { Label } from "~/components/ui/label.tsx";
import { useIsMobile } from "~/components/ui/sidebar.tsx";
import { useActingAccount } from "~/contexts/ActingAccountContext.tsx";
import { ComposerActionBar } from "~/components/article-composer/shared/ComposerActionBar.tsx";
import { ComposerEditorPanes } from "~/components/article-composer/shared/ComposerEditorPanes.tsx";
import { ComposerTitleField } from "~/components/article-composer/shared/ComposerTitleField.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { uploadImageForArticleSource } from "~/lib/uploadImage.ts";
import type { editPageQuery } from "./__generated__/editPageQuery.graphql.ts";
import type {
  edit_article$data,
  edit_article$key,
} from "./__generated__/edit_article.graphql.ts";
import type { edit_renderMarkdown_Query } from "./__generated__/edit_renderMarkdown_Query.graphql.ts";
import type { edit_updateArticle_Mutation } from "./__generated__/edit_updateArticle_Mutation.graphql.ts";
import {
  createStablePreloadedQuery,
  routePreloadedQuery,
} from "~/lib/relayPreload.ts";

export const route = {
  matchFilters: {
    handle: /^@/,
  },
} satisfies RouteDefinition;

const editPageQueryDef = graphql`
  query editPageQuery(
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
      ...edit_article @arguments(actingAccountId: $actingAccountId)
    }
    viewer {
      organizationMemberships {
        organization {
          id
        }
      }
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
    loadQuery<editPageQuery>(
      useRelayEnvironment()(),
      editPageQueryDef,
      { handle, idOrYear, slug, actingAccountId },
      { fetchPolicy: "network-only" },
    ),
  "loadArticleEditPageQuery",
);

export default function ArticleEditPage() {
  const params = useParams();
  const handle = decodeRouteParam(params.handle!);
  const idOrYear = params.idOrYear!;
  const slug = decodeRouteParam(params.slug!);
  const actingAccount = useActingAccount();
  const actingAccountId = () => actingAccount.selectedActingAccountId();

  const data = createStablePreloadedQuery<editPageQuery>(
    editPageQueryDef,
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
            <ArticleEditForm
              $article={article}
              viewerOrganizationIds={data.viewer?.organizationMemberships.map((
                membership,
              ) => membership.organization.id) ?? []}
            />
          )}
        </Show>
      )}
    </Show>
  );
}

interface ArticleEditFormProps {
  $article: edit_article$key;
  viewerOrganizationIds: readonly string[];
}

const renderMarkdownQuery = graphql`
  query edit_renderMarkdown_Query(
    $content: String!
    $articleSourceId: UUID
    $actingAccountId: ID
  ) {
    renderMarkdown(
      content: $content
      articleSourceId: $articleSourceId
      actingAccountId: $actingAccountId
    )
  }
`;

const updateArticleMutation = graphql`
  mutation edit_updateArticle_Mutation($input: UpdateArticleInput!) {
    updateArticle(input: $input) {
      __typename
      ... on UpdateArticlePayload {
        article {
          id
          url
          ...Slug_head
          contents(includeBeingTranslated: false) {
            title
            content
            toc
            language
            originalLanguage
            beingTranslated
          }
          allContents: contents(includeBeingTranslated: true) {
            language
            url
          }
          language
          tags
          allowLlmTranslation
          publishedYear
          slug
        }
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on NotAuthenticatedError {
        notAuthenticated
      }
    }
  }
`;

function ArticleEditForm(props: ArticleEditFormProps) {
  const article = createFragment(
    graphql`
      fragment edit_article on Article
        @argumentDefinitions(actingAccountId: { type: "ID", defaultValue: null })
      {
        id
        sourceId
        actor {
          personalIsViewer: isViewer
          isViewer(actingAccountId: $actingAccountId)
          account {
            id
          }
          username
        }
        contents {
          title
          content
          rawContent
          language
          originalLanguage
        }
        tags
        allowLlmTranslation
        publishedYear
        slug
      }
    `,
    () => props.$article,
  );

  const authoringOrganizationId = () => {
    const ownerAccountId = article()?.actor.account?.id;
    if (ownerAccountId == null) return null;
    return props.viewerOrganizationIds.includes(ownerAccountId)
      ? ownerAccountId
      : null;
  };
  const canEdit = () =>
    article()?.actor.personalIsViewer === true ||
    article()?.actor.isViewer === true ||
    authoringOrganizationId() != null;

  // Authorization runs on the server so unauthorized requests get an actual
  // HTTP 403 instead of a blank 200 page. Organization-authored articles need
  // a server-derived membership check because the client-selected acting
  // account is localStorage-backed and is unavailable during SSR.
  return (
    <Show
      when={article() == null || canEdit()}
      fallback={<HttpStatusCode code={403} />}
    >
      <ArticleEditFormGate
        article={canEdit() ? article() : undefined}
        actingAccountIdFallback={authoringOrganizationId()}
      />
    </Show>
  );
}

interface ArticleEditFormGateProps {
  article: edit_article$data | null | undefined;
  actingAccountIdFallback: string | null;
}

function ArticleEditFormGate(props: ArticleEditFormGateProps) {
  // The Relay store starts empty on the client after hydration, so
  // `props.article` is initially undefined there even though the SSR
  // render had data. Defer mounting the inner form until the fragment
  // resolves so signals don't lock in empty initial values. To keep SSR
  // and the client's first render in agreement (avoiding a hydration
  // mismatch), the server also withholds the form until the client
  // loads it.
  const loadedArticle = () => (isServer ? undefined : props.article);
  return (
    <Show keyed when={loadedArticle()}>
      {(article) => (
        <ArticleEditFormInner
          article={article}
          actingAccountIdFallback={props.actingAccountIdFallback}
        />
      )}
    </Show>
  );
}

interface ArticleEditFormInnerProps {
  article: edit_article$data;
  actingAccountIdFallback: string | null;
}

function ArticleEditFormInner(props: ArticleEditFormInnerProps) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const environment = useRelayEnvironment();
  const actingAccount = useActingAccount();
  const isMobile = useIsMobile();

  const article = () => props.article;
  const actingAccountIdForArticle = () => {
    const selected = actingAccount.selectedActingAccountId();
    const ownerAccountId = article().actor.account?.id;
    if (article().actor.personalIsViewer) return null;
    return selected != null && selected === ownerAccountId
      ? selected
      : props.actingAccountIdFallback;
  };

  const [commitUpdate, isUpdating] = createMutation<
    edit_updateArticle_Mutation
  >(updateArticleMutation);

  // Initialize form state from the original content (not translations).
  const initialContent = article().contents?.find((c) =>
    c.originalLanguage == null
  );
  const [title, setTitle] = createSignal(initialContent?.title ?? "");
  const [markdown, setMarkdown] = createSignal(
    initialContent?.rawContent ?? "",
  );
  const [tags, setTags] = createSignal<string[]>([...(article().tags ?? [])]);
  const [language, setLanguage] = createSignal<Intl.Locale | undefined>(
    initialContent?.language
      ? new Intl.Locale(initialContent.language)
      : undefined,
  );
  const [allowLlmTranslation, setAllowLlmTranslation] = createSignal(
    article().allowLlmTranslation ?? false,
  );

  // Two-stage flow: Stage 1 is the writing surface; Stage 2 the settings.
  const [showSettings, setShowSettings] = createSignal(false);
  const [showPreview, setShowPreview] = createSignal(false);

  // Markdown preview. Unlike the draft composer there's no draft save to
  // piggyback on, so the preview is produced by calling `renderMarkdown`
  // directly (debounced while editing). The initial preview is seeded from the
  // article's already-rendered HTML so it shows immediately without a fetch.
  const [previewHtml, setPreviewHtml] = createSignal(
    initialContent?.content ?? "",
  );
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewError, setPreviewError] = createSignal(false);
  let lastRenderedText = initialContent?.rawContent ?? "";
  let lastRenderedHtml = initialContent?.content ?? "";
  let previewRequestVersion = 0;
  let previewSubscription: { unsubscribe: () => void } | undefined;

  onCleanup(() => previewSubscription?.unsubscribe());

  const renderPreview = (text: string) => {
    previewSubscription?.unsubscribe();
    previewSubscription = undefined;
    if (!text) {
      lastRenderedText = "";
      setPreviewHtml("");
      setPreviewError(false);
      setPreviewLoading(false);
      return;
    }
    if (text === lastRenderedText) {
      setPreviewHtml(lastRenderedHtml);
      setPreviewError(false);
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    setPreviewError(false);
    const requestVersion = ++previewRequestVersion;
    previewSubscription = fetchQuery<edit_renderMarkdown_Query>(
      environment(),
      renderMarkdownQuery,
      {
        content: text,
        articleSourceId: article().sourceId ?? null,
        actingAccountId: actingAccountIdForArticle(),
      },
    ).subscribe({
      next(data) {
        if (requestVersion !== previewRequestVersion) return;
        lastRenderedText = text;
        lastRenderedHtml = data.renderMarkdown;
        setPreviewHtml(data.renderMarkdown);
        setPreviewLoading(false);
      },
      error() {
        if (requestVersion !== previewRequestVersion) return;
        setPreviewError(true);
        // Drop the stale HTML so the failure is visible rather than silently
        // showing the previously rendered content for older markdown.
        setPreviewHtml("");
        setPreviewLoading(false);
      },
    });
  };

  const debouncedRenderPreview = debounce(renderPreview, 800);
  onCleanup(() => debouncedRenderPreview.cancel());

  // Keep the preview live while editing. On desktop both panes are always
  // visible; on mobile only render when the preview pane is actually shown.
  createEffect(() => {
    if (showSettings()) return;
    if (isMobile() && !showPreview()) return;
    debouncedRenderPreview(markdown().trim());
  });

  const handleShowPreviewChange = (next: boolean) => {
    setShowPreview(next);
    // Render immediately on switch rather than waiting for the debounce.
    if (next) renderPreview(markdown().trim());
  };

  const handleImageUpload = async (
    file: File,
  ): Promise<{ url: string }> => {
    const sourceId = article().sourceId;
    if (sourceId == null) {
      // Should be unreachable: federated remote articles fail the
      // isViewer gate above, so we never mount this form for them.
      throw new Error("Article has no local source");
    }
    try {
      const actingAccountId = actingAccountIdForArticle();
      const result = await uploadImageForArticleSource(
        file,
        sourceId,
        actingAccountId ?? null,
      );
      return { url: result.url };
    } catch (error) {
      showToast({
        title: t`Error`,
        description: error instanceof Error
          ? error.message
          : t`Failed to upload image`,
        variant: "error",
      });
      throw error;
    }
  };

  const handleSave = () => {
    const actingAccountId = actingAccountIdForArticle();
    commitUpdate({
      variables: {
        input: {
          articleId: article().id,
          ...(actingAccountId == null ? {} : { actingAccountId }),
          title: title(),
          content: markdown(),
          tags: tags(),
          language: language()?.baseName,
          allowLlmTranslation: allowLlmTranslation(),
        },
      },
      async onCompleted(response) {
        if (
          response.updateArticle.__typename === "UpdateArticlePayload"
        ) {
          showToast({
            title: t`Success`,
            description: t`Article updated`,
            variant: "success",
          });
          const articleUrl = response.updateArticle.article.url;
          if (articleUrl) {
            await revalidate("loadArticlePageQuery").catch((error) => {
              console.error("Failed to revalidate article page:", error);
            });
            navigate(new URL(articleUrl).pathname);
          }
        } else if (
          response.updateArticle.__typename === "InvalidInputError"
        ) {
          const inputPath = response.updateArticle.inputPath;
          showToast({
            title: t`Error`,
            description: inputPath === "language"
              ? t`Cannot change the language because translations already exist`
              : t`Invalid input: ${inputPath}`,
            variant: "error",
          });
        } else if (
          response.updateArticle.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to edit an article`,
            variant: "error",
          });
        }
      },
      onError(error) {
        console.error("Failed to update article:", error);
        showToast({
          title: t`Error`,
          description: t`Failed to update the article. Please try again.`,
          variant: "error",
        });
      },
    });
  };

  const handleCancel = () => {
    const a = article();
    navigate(`/@${a.actor.username}/${a.publishedYear}/${a.slug}`);
  };

  return (
    <div class="flex h-[100dvh] flex-col overflow-hidden">
      <Title>{t`Edit article`}</Title>
      <form
        onSubmit={(e) => e.preventDefault()}
        class="flex min-h-0 flex-1 flex-col"
      >
        <Show
          when={!showSettings()}
          fallback={
            <>
              <div class="shrink-0 border-b px-4 py-4 sm:px-6">
                <h1 class="text-lg font-semibold leading-none tracking-tight">
                  {t`Article settings`}
                </h1>
                <p class="mt-1.5 text-sm text-muted-foreground">
                  {t`Update how this article is described and discovered.`}
                </p>
              </div>

              <div class="min-h-0 flex-1 overflow-y-auto">
                <div class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 sm:px-6">
                  <div class="flex flex-col gap-1.5">
                    <Label>{t`Tags`}</Label>
                    <TagInput
                      value={tags()}
                      onChange={setTags}
                      placeholder={t`Type tags separated by spaces`}
                    />
                    <p class="text-sm text-muted-foreground leading-6">
                      {t`Separate tags with spaces. Tags help readers discover your article.`}
                    </p>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <Label>{t`Language`}</Label>
                    <LanguageSelect
                      class="w-full"
                      value={language()}
                      onChange={setLanguage}
                    />
                    <p class="text-sm text-muted-foreground leading-6">
                      {t`The primary language of your article, used for accessibility and discovery.`}
                    </p>
                  </div>

                  <div class="flex items-start gap-2">
                    <input
                      id="allow-llm-translation"
                      type="checkbox"
                      checked={allowLlmTranslation()}
                      onChange={(e) =>
                        setAllowLlmTranslation(e.currentTarget.checked)}
                      aria-describedby="allow-llm-translation-description"
                      class="mt-0.5 cursor-pointer rounded border-input"
                    />
                    <div class="grid gap-1.5 leading-none">
                      <label
                        for="allow-llm-translation"
                        class="cursor-pointer text-sm font-medium leading-none"
                      >
                        {t`Allow automatic translation by AI`}
                      </label>
                      <p
                        id="allow-llm-translation-description"
                        class="text-sm text-muted-foreground leading-6"
                      >
                        {t`When enabled, AI may automatically translate this article into other languages.`}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <ComposerActionBar
                end={
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowSettings(false)}
                    >
                      {t`Back to editing`}
                    </Button>
                    <Button
                      type="button"
                      onClick={handleSave}
                      disabled={isUpdating()}
                    >
                      <Show when={isUpdating()}>
                        <IconLoader2
                          class="size-4 animate-spin"
                          aria-hidden="true"
                        />
                      </Show>
                      {isUpdating() ? t`Saving…` : t`Save changes`}
                    </Button>
                  </>
                }
              />
            </>
          }
        >
          <ComposerTitleField
            value={title()}
            onInput={setTitle}
            placeholder={t`Title`}
          />
          <ComposerEditorPanes
            content={markdown()}
            onContentInput={setMarkdown}
            contentPlaceholder={t`Write your article here.`}
            onImageUpload={handleImageUpload}
            previewHtml={previewHtml()}
            previewPending={previewLoading()}
            previewError={previewError()}
            previewEmptyLabel={t`Start writing to see a preview.`}
            showPreview={showPreview()}
            onShowPreviewChange={handleShowPreviewChange}
          />
          <ComposerActionBar
            start={
              <Button type="button" variant="ghost" onClick={handleCancel}>
                {t`Cancel`}
              </Button>
            }
            end={
              <Button
                type="button"
                onClick={() => {
                  if (!title().trim()) {
                    showToast({
                      title: t`Error`,
                      description: t`Title cannot be empty`,
                      variant: "error",
                    });
                    return;
                  }
                  setShowSettings(true);
                }}
              >
                {t`Continue`}
              </Button>
            }
          />
        </Show>
      </form>
    </div>
  );
}
