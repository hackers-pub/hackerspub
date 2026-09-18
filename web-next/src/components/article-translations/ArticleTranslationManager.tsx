import { createEffect, createSignal, For, Show } from "solid-js";
import { createMutation } from "solid-relay";
import { graphql } from "relay-runtime";
import { HtmlContent } from "~/components/HtmlContent.tsx";
import { LanguageName } from "~/components/LanguageName.tsx";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { Button } from "~/components/ui/button.tsx";
import { MarkdownEditor } from "~/components/ui/markdown-editor.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import type { ArticleTranslationManagerSaveMutation } from "./__generated__/ArticleTranslationManagerSaveMutation.graphql.ts";
import type { ArticleTranslationManagerDeleteMutation } from "./__generated__/ArticleTranslationManagerDeleteMutation.graphql.ts";
import type { ArticleTranslationManagerPublishMutation } from "./__generated__/ArticleTranslationManagerPublishMutation.graphql.ts";

const SaveMutation = graphql`
  mutation ArticleTranslationManagerSaveMutation(
    $input: SaveArticleTranslationDraftInput!
  ) {
    saveArticleTranslationDraft(input: $input) {
      __typename
      ... on SaveArticleTranslationDraftPayload {
        draft {
          uuid
          language
          title
          content
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
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
    }
  }
`;

const DeleteMutation = graphql`
  mutation ArticleTranslationManagerDeleteMutation(
    $input: DeleteArticleTranslationDraftInput!
  ) {
    deleteArticleTranslationDraft(input: $input) {
      __typename
      ... on DeleteArticleTranslationDraftPayload {
        deletedDraftId
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
    }
  }
`;

const PublishMutation = graphql`
  mutation ArticleTranslationManagerPublishMutation(
    $input: PublishArticleTranslationInput!
  ) {
    publishArticleTranslation(input: $input) {
      __typename
      ... on PublishArticleTranslationPayload {
        language
      }
      ... on InvalidInputError {
        inputPath
      }
      ... on ArticleDraftConflictError {
        currentRevision
      }
    }
  }
`;

export type TranslationUuid =
  `${string}-${string}-${string}-${string}-${string}`;

export interface ArticleTranslationView {
  uuid: TranslationUuid;
  language: string;
  title: string;
  content: string;
  revision: number;
  publishedRevision: number | null;
  provenance: string;
  publicationState: string;
  sourceChanged: boolean;
  translatorUsername: string | null;
  contentHtml: string;
}

export interface ArticleTranslationManagerProps {
  scope: { articleDraftId: TranslationUuid } | { sourceId: TranslationUuid };
  originalTitle: string;
  originalLanguage: string | null;
  translations: ArticleTranslationView[];
  canPublishIndependently: boolean;
  onChanged: () => void | Promise<void>;
}

export function ArticleTranslationManager(
  props: ArticleTranslationManagerProps,
) {
  const { t } = useLingui();
  const [saveMutation, saving] =
    createMutation<ArticleTranslationManagerSaveMutation>(SaveMutation);
  const [deleteMutation, deleting] =
    createMutation<ArticleTranslationManagerDeleteMutation>(DeleteMutation);
  const [publishMutation, publishing] =
    createMutation<ArticleTranslationManagerPublishMutation>(PublishMutation);
  const [selectedUuid, setSelectedUuid] = createSignal<
    TranslationUuid | undefined
  >();
  const [newLanguage, setNewLanguage] = createSignal<Intl.Locale | undefined>();
  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal("");
  const [error, setError] = createSignal<string | undefined>();
  // True while a mutation's follow-up reload is in flight, so the editor is
  // not reset under the user's fingers between the save echo and the refetch.
  const [reloading, setReloading] = createSignal(false);
  const newLanguageCode = () => newLanguage()?.baseName;
  // The original language and every language that already has a draft cannot
  // be added again: existing drafts are opened from the list instead.
  const unavailableLanguages = () => {
    const codes = new Set<string>();
    if (props.originalLanguage != null) {
      codes.add(new Intl.Locale(props.originalLanguage).baseName);
    }
    for (const translation of props.translations) {
      codes.add(new Intl.Locale(translation.language).baseName);
    }
    return [...codes].map((code) => new Intl.Locale(code));
  };

  const selected = () =>
    props.translations.find((t) => t.uuid === selectedUuid());

  // Load the selected translation into the editor. Switching languages resets
  // the fields, but the unsaved text of the previously selected language is
  // intentionally not silently kept: each language has its own saved draft.
  createEffect(() => {
    const translation = selected();
    setTitle(translation?.title ?? "");
    setContent(translation?.content ?? "");
    setError(undefined);
  });

  const scopeInput = () =>
    "articleDraftId" in props.scope
      ? { articleDraftId: props.scope.articleDraftId }
      : { sourceId: props.scope.sourceId };

  const refresh = async () => {
    setReloading(true);
    try {
      await props.onChanged();
    } finally {
      setReloading(false);
    }
  };

  const busy = () => saving() || deleting() || publishing() || reloading();

  const handleSave = (
    revision?: number,
    afterSave?: (draft: { uuid: TranslationUuid; revision: number }) => void,
  ) => {
    const language = selected()?.language ?? newLanguageCode();
    if (language == null) return;
    setError(undefined);
    saveMutation({
      variables: {
        input: {
          ...scopeInput(),
          ...(revision != null && selectedUuid() != null
            ? { id: selectedUuid(), revision }
            : {}),
          language,
          title: title(),
          content: content(),
        },
      },
      onCompleted(response) {
        const payload = response.saveArticleTranslationDraft;
        if (payload.__typename === "SaveArticleTranslationDraftPayload") {
          setSelectedUuid(payload.draft.uuid);
          setNewLanguage(undefined);
          if (afterSave != null) {
            afterSave({
              uuid: payload.draft.uuid,
              revision: payload.draft.revision,
            });
            return;
          }
          void refresh();
          return;
        }
        if (payload.__typename === "InvalidInputError") {
          setError(t`That language is not available or the input is invalid.`);
        } else if (payload.__typename === "ArticleDraftConflictError") {
          setError(
            t`Someone else saved this translation. Reload and try again.`,
          );
        } else {
          setError(t`You may not have permission to save this translation.`);
        }
      },
      onError() {
        setError(t`Failed to save the translation.`);
      },
    });
  };

  const handleDelete = () => {
    const translation = selected();
    if (translation == null) return;
    deleteMutation({
      variables: {
        input: { id: translation.uuid, revision: translation.revision },
      },
      onCompleted(response) {
        const payload = response.deleteArticleTranslationDraft;
        if (payload.__typename === "DeleteArticleTranslationDraftPayload") {
          setSelectedUuid(undefined);
          void refresh();
          return;
        }
        if (payload.__typename === "ArticleDraftConflictError") {
          setError(
            t`Someone else saved this translation. Reload and try again.`,
          );
        } else if (payload.__typename === "InvalidInputError") {
          setError(t`Failed to delete the translation draft.`);
        } else {
          setError(t`You may not have permission to delete this translation.`);
        }
      },
      onError() {
        setError(t`Failed to delete the translation draft.`);
      },
    });
  };

  const publish = (id: TranslationUuid, revision: number) => {
    setError(undefined);
    publishMutation({
      variables: { input: { id, revision } },
      onCompleted(response) {
        const payload = response.publishArticleTranslation;
        if (payload.__typename === "ArticleDraftConflictError") {
          setError(
            t`Someone else saved this translation. Reload and try again.`,
          );
        } else if (payload.__typename === "InvalidInputError") {
          setError(t`Failed to publish the translation.`);
        } else {
          setError(t`You may not have permission to publish this translation.`);
        }
        void refresh();
      },
      onError() {
        setError(t`Failed to publish the translation.`);
      },
    });
  };

  const handlePublish = () => {
    const translation = selected();
    if (translation == null) return;
    // Publishing must not discard unsaved editor text: persist it first and
    // publish the revision that save returned.
    const dirty =
      title() !== translation.title || content() !== translation.content;
    if (dirty) {
      handleSave(translation.revision, (saved) => {
        publish(saved.uuid, saved.revision);
      });
    } else {
      publish(translation.uuid, translation.revision);
    }
  };

  return (
    <div class="flex flex-col gap-6 lg:flex-row">
      <aside class="lg:w-80 shrink-0">
        <h2 class="mb-2 text-lg font-semibold">{t`Languages`}</h2>
        <ul class="flex flex-col gap-1">
          <For each={props.translations}>
            {(translation) => (
              <li>
                <button
                  type="button"
                  classList={{
                    "flex w-full flex-col items-start rounded-md border px-3 py-2 text-left text-sm": true,
                    "border-primary bg-accent":
                      selectedUuid() === translation.uuid,
                    "border-border": selectedUuid() !== translation.uuid,
                  }}
                  onClick={() => setSelectedUuid(translation.uuid)}
                >
                  <span class="font-medium">
                    <LanguageName code={translation.language} />
                  </span>
                  <span class="text-xs text-muted-foreground">
                    <Show
                      when={translation.translatorUsername}
                      fallback={t`No translator credit`}
                    >
                      {(username) => (
                        <>
                          {t`Translated by`} @{username()}
                        </>
                      )}
                    </Show>
                  </span>
                  <span class="text-xs text-muted-foreground">
                    {translation.publicationState === "PUBLISHED"
                      ? t`Published`
                      : translation.publicationState ===
                          "PUBLISHED_WITH_CHANGES"
                        ? t`Published; unpublished changes`
                        : t`Not published`}
                    <Show when={translation.sourceChanged}>
                      {" · "}
                      {t`Needs review`}
                    </Show>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>

        <h3 class="mt-6 mb-2 text-sm font-semibold">{t`Add translation`}</h3>
        <div class="flex flex-col gap-2">
          <LanguageSelect
            class="w-full"
            value={newLanguage() ?? null}
            onChange={setNewLanguage}
            exclude={unavailableLanguages()}
          />
          <Button
            size="sm"
            disabled={newLanguage() == null || busy()}
            onClick={() => {
              setSelectedUuid(undefined);
              handleSave();
            }}
          >
            {t`Add`}
          </Button>
        </div>
        <p class="mt-2 text-xs text-muted-foreground">
          {t`If a private draft already exists for a language, it opens instead of creating a duplicate.`}
        </p>
      </aside>

      <section class="min-w-0 flex-1">
        <Show
          when={selected() != null || newLanguage() != null}
          fallback={
            <p class="text-sm text-muted-foreground">
              {t`Select a language to edit its translation.`}
            </p>
          }
        >
          <Show when={selected()?.sourceChanged}>
            <div class="mb-2 flex items-center justify-end gap-2">
              <span class="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                {t`The original changed; this translation may be out of date.`}
              </span>
            </div>
          </Show>

          <input
            class="mb-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder={t`Translated title`}
            value={title()}
            disabled={busy()}
            onInput={(event) => setTitle(event.currentTarget.value)}
          />

          <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <div class="min-h-[16rem] rounded-md border border-border">
              <MarkdownEditor
                value={content()}
                onInput={setContent}
                ariaLabel={t`Translated body`}
                minHeight="16rem"
                disabled={busy()}
              />
            </div>
            <div class="hidden min-h-[16rem] overflow-auto rounded-md border border-border p-3 xl:block">
              <p class="mb-2 text-xs font-medium text-muted-foreground">
                {t`Original`}
              </p>
              <p class="text-sm">{props.originalTitle}</p>
            </div>
          </div>

          <Show when={selected()?.contentHtml}>
            {(html) => (
              <div class="mt-3 rounded-md border border-border p-3">
                <p class="mb-2 text-xs font-medium text-muted-foreground">
                  {t`Preview`}
                </p>
                <HtmlContent html={html()} class="prose prose-sm max-w-none" />
              </div>
            )}
          </Show>

          <Show when={error()}>
            {(message) => (
              <p class="mt-3 text-sm text-destructive">{message()}</p>
            )}
          </Show>

          <div class="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={
                busy() || title().trim() === "" || content().trim() === ""
              }
              onClick={() => handleSave(selected()?.revision)}
            >
              {t`Save draft`}
            </Button>
            <Show when={props.canPublishIndependently && selected() != null}>
              <Button
                variant="default"
                disabled={
                  busy() || title().trim() === "" || content().trim() === ""
                }
                onClick={handlePublish}
              >
                {selected()?.publicationState === "UNPUBLISHED"
                  ? t`Publish translation`
                  : t`Publish changes`}
              </Button>
            </Show>
            <Show when={selected() != null}>
              <Button
                variant="destructive"
                disabled={busy()}
                onClick={handleDelete}
              >
                {t`Delete draft`}
              </Button>
            </Show>
          </div>
        </Show>
      </section>
    </div>
  );
}
