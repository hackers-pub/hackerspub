import { detectLanguage } from "@hackerspub/models/langdet";
import { debounce } from "es-toolkit";
import { graphql } from "relay-runtime";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { TagInput } from "~/components/TagInput.tsx";
import { Button } from "~/components/ui/button.tsx";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { ArticleComposerSaveMutation } from "./__generated__/ArticleComposerSaveMutation.graphql.ts";
import type { ArticleComposerPublishMutation } from "./__generated__/ArticleComposerPublishMutation.graphql.ts";
import type { ArticleComposerDeleteMutation } from "./__generated__/ArticleComposerDeleteMutation.graphql.ts";
import type { ArticleComposerDraftQuery as ArticleComposerDraftQueryType } from "./__generated__/ArticleComposerDraftQuery.graphql.ts";
import { useBeforeLeave, useNavigate } from "@solidjs/router";

const SaveArticleDraftMutation = graphql`
  mutation ArticleComposerSaveMutation(
    $input: SaveArticleDraftInput!
    $connections: [ID!]!
  ) {
    saveArticleDraft(input: $input) {
      __typename
      ... on SaveArticleDraftPayload {
        draft @prependNode(
          connections: $connections
          edgeTypeName: "AccountArticleDraftsConnectionEdge"
        ) {
          id
          uuid
          title
          content
          tags
          updated
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

const PublishArticleDraftMutation = graphql`
  mutation ArticleComposerPublishMutation($input: PublishArticleDraftInput!) {
    publishArticleDraft(input: $input) {
      __typename
      ... on PublishArticleDraftPayload {
        article {
          id
          url
        }
        deletedDraftId @deleteRecord
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

const DeleteArticleDraftMutation = graphql`
  mutation ArticleComposerDeleteMutation(
    $input: DeleteArticleDraftInput!
    $connections: [ID!]!
  ) {
    deleteArticleDraft(input: $input) {
      __typename
      ... on DeleteArticleDraftPayload {
        deletedDraftId @deleteEdge(connections: $connections)
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

const ArticleComposerDraftQuery = graphql`
  query ArticleComposerDraftQuery($uuid: UUID!) {
    articleDraft(uuid: $uuid) {
      id
      uuid
      title
      content
      tags
    }
  }
`;

export interface ArticleComposerProps {
  draftUuid?: string;
  onSaved?: (draftId: string, draftUuid: string) => void;
  onPublished?: (articleUrl: string) => void;
  viewerId?: string;
}

export function ArticleComposer(props: ArticleComposerProps) {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const env = useRelayEnvironment();

  // Conditionally load draft data when draftUuid provided
  const loadDraft = () => {
    if (!props.draftUuid) {
      // Return a dummy promise that never resolves for the no-draft case
      // This prevents createPreloadedQuery from trying to load when there's no UUID
      return new Promise<never>(() => {});
    }

    return loadQuery<ArticleComposerDraftQueryType>(
      env(),
      ArticleComposerDraftQuery,
      {
        uuid: props
          .draftUuid as `${string}-${string}-${string}-${string}-${string}`,
      },
    );
  };

  const draftData = createPreloadedQuery<ArticleComposerDraftQueryType>(
    ArticleComposerDraftQuery,
    loadDraft,
  );

  // Extract draft from query result
  const draft = createMemo(() => {
    if (!props.draftUuid) return undefined;
    return draftData()?.articleDraft;
  });

  // State
  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [slug, setSlug] = createSignal("");
  const [language, setLanguage] = createSignal<Intl.Locale | undefined>(
    new Intl.Locale(i18n.locale),
  );
  const [manualLanguageChange, setManualLanguageChange] = createSignal(false);
  const [isDirty, setIsDirty] = createSignal(false);
  const [isPublishing, setIsPublishing] = createSignal(false);

  // Connection IDs for Relay cache updates
  const connectionIds = () => {
    const ids: string[] = [];
    const viewerId = props.viewerId;

    if (viewerId) {
      // Construct connection IDs manually using Relay's naming convention
      // AppSidebar uses @connection(key: "SignedAccount_articleDrafts")
      const sidebarId =
        `client:${viewerId}:__SignedAccount_articleDrafts_connection`;

      // Drafts list page uses @connection(key: "draftsPaginationFragment_articleDrafts")
      const listId =
        `client:${viewerId}:__draftsPaginationFragment_articleDrafts_connection`;

      // FloatingComposeButton uses @connection(key: "FloatingComposeButton_articleDrafts")
      const floatingButtonId =
        `client:${viewerId}:__FloatingComposeButton_articleDrafts_connection`;

      ids.push(sidebarId);
      ids.push(listId);
      ids.push(floatingButtonId);
    }

    return ids;
  };

  // Mutations
  const [saveDraft, isSaving] = createMutation<ArticleComposerSaveMutation>(
    SaveArticleDraftMutation,
  );
  const [publishDraft, isPublishingMutation] = createMutation<
    ArticleComposerPublishMutation
  >(
    PublishArticleDraftMutation,
  );
  const [deleteDraft, isDeleting] = createMutation<
    ArticleComposerDeleteMutation
  >(
    DeleteArticleDraftMutation,
  );

  // Create debounced auto-save (1.5 second interval)
  const debouncedAutoSave = debounce(() => {
    // Only auto-save if not already saving and has required content
    if (!isSaving() && title().trim() && isDirty()) {
      handleSaveDraft();
    }
  }, 1500);

  // Populate form when draft loads
  createEffect(() => {
    const currentDraft = draft();
    if (currentDraft) {
      setTitle(currentDraft.title);
      setContent(currentDraft.content);
      setTags([...currentDraft.tags]);
    }
  });

  // Auto-detect language from content
  createEffect(() => {
    if (manualLanguageChange()) return;

    const text = content().trim();
    const detectedLang = detectLanguage({
      text,
      acceptLanguage: null,
    });

    if (detectedLang) {
      setLanguage(new Intl.Locale(detectedLang));
    }
  });

  const handleLanguageChange = (locale?: Intl.Locale) => {
    setLanguage(locale);
    setManualLanguageChange(true);
  };

  // Track dirty state
  createEffect(() => {
    const currentDraft = draft();
    const hasChanges = title() !== (currentDraft?.title ?? "") ||
      content() !== (currentDraft?.content ?? "") ||
      JSON.stringify(tags()) !== JSON.stringify(currentDraft?.tags ?? []);
    setIsDirty(hasChanges);
  });

  // Auto-save effect
  createEffect(() => {
    // Trigger auto-save when dirty state changes to true
    if (isDirty() && !isPublishing()) {
      debouncedAutoSave();
    }

    // Clean up on unmount
    onCleanup(() => {
      debouncedAutoSave.cancel();
    });
  });

  // Router navigation guard
  useBeforeLeave((e) => {
    if (isDirty() && !e.defaultPrevented) {
      e.preventDefault();
      setTimeout(() => {
        if (window.confirm(t`Discard unsaved changes - are you sure?`)) {
          e.retry(true);
        }
      }, 100);
    }
  });

  // Browser refresh/close guard
  createEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty()) {
        e.preventDefault();
        e.returnValue = ""; // Chrome requires returnValue to be set
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    onCleanup(() => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    });
  });

  // Auto-generate slug from title
  createEffect(() => {
    const titleValue = title();
    if (titleValue && !slug()) {
      const autoSlug = titleValue
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 128);
      setSlug(autoSlug);
    }
  });

  const handleSaveDraft = (e?: Event) => {
    e?.preventDefault();

    if (!title().trim()) {
      showToast({
        title: t`Error`,
        description: t`Title cannot be empty`,
        variant: "error",
      });
      return;
    }

    saveDraft({
      variables: {
        input: {
          id: draft()?.id,
          title: title().trim(),
          content: content().trim(),
          tags: tags(),
        },
        connections: connectionIds(),
      },
      onCompleted(response) {
        if (
          response.saveArticleDraft.__typename === "SaveArticleDraftPayload"
        ) {
          const draft = response.saveArticleDraft.draft;

          // Update view with server response (normalized tags, generated ID, etc.)
          setTitle(draft.title);
          setContent(draft.content);
          setTags([...draft.tags]);
          setIsDirty(false);

          showToast({
            title: t`Success`,
            description: t`Draft saved`,
            variant: "success",
          });
          props.onSaved?.(draft.id, draft.uuid);
        } else if (
          response.saveArticleDraft.__typename === "InvalidInputError"
        ) {
          showToast({
            title: t`Error`,
            description:
              t`Invalid input: ${response.saveArticleDraft.inputPath}`,
            variant: "error",
          });
        } else if (
          response.saveArticleDraft.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to save a draft`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Error`,
          description: error.message,
          variant: "error",
        });
      },
    });
  };

  const handlePublish = (e: Event) => {
    e.preventDefault();

    if (!slug().trim()) {
      showToast({
        title: t`Error`,
        description: t`Slug cannot be empty`,
        variant: "error",
      });
      return;
    }

    if (!draft()?.id) {
      showToast({
        title: t`Error`,
        description: t`Draft must be saved before publishing`,
        variant: "error",
      });
      return;
    }

    publishDraft({
      variables: {
        input: {
          id: draft()!.id,
          slug: slug().trim(),
          language: language()?.baseName ?? i18n.locale,
          allowLlmTranslation: true,
        },
      },
      onCompleted(response) {
        if (
          response.publishArticleDraft.__typename ===
            "PublishArticleDraftPayload"
        ) {
          navigate(response.publishArticleDraft.article.url!);
          setIsDirty(false);
          showToast({
            title: t`Success`,
            description: t`Article published`,
            variant: "success",
          });
        } else if (
          response.publishArticleDraft.__typename === "InvalidInputError"
        ) {
          showToast({
            title: t`Error`,
            description:
              t`Invalid input: ${response.publishArticleDraft.inputPath}`,
            variant: "error",
          });
        } else if (
          response.publishArticleDraft.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to publish an article`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Error`,
          description: error.message,
          variant: "error",
        });
      },
    });
  };

  const handleDelete = () => {
    if (!draft()?.id) {
      showToast({
        title: t`Error`,
        description: t`No draft to delete`,
        variant: "error",
      });
      return;
    }

    if (
      !confirm(
        t`Are you sure you want to delete this draft? This action cannot be undone.`,
      )
    ) {
      return;
    }

    deleteDraft({
      variables: {
        input: {
          id: draft()!.id,
        },
        connections: connectionIds(),
      },
      onCompleted(response) {
        if (
          response.deleteArticleDraft.__typename === "DeleteArticleDraftPayload"
        ) {
          setIsDirty(false);
          navigate(`..`);
          showToast({
            title: t`Success`,
            description: t`Draft deleted`,
            variant: "success",
          });
        } else if (
          response.deleteArticleDraft.__typename === "InvalidInputError"
        ) {
          showToast({
            title: t`Error`,
            description:
              t`Invalid input: ${response.deleteArticleDraft.inputPath}`,
            variant: "error",
          });
        } else if (
          response.deleteArticleDraft.__typename === "NotAuthenticatedError"
        ) {
          showToast({
            title: t`Error`,
            description: t`You must be signed in to delete a draft`,
            variant: "error",
          });
        }
      },
      onError(error) {
        showToast({
          title: t`Error`,
          description: error.message,
          variant: "error",
        });
      },
    });
  };

  return (
    <Show
      when={!props.draftUuid || draftData()}
      fallback={
        <div class="max-w-4xl mx-auto p-6 text-center text-muted-foreground">
          {t`Loading draft...`}
        </div>
      }
    >
      <Show
        when={!props.draftUuid || draft()}
        fallback={
          <div class="max-w-4xl mx-auto p-6 text-center text-muted-foreground">
            {t`Draft not found`}
          </div>
        }
      >
        <div class="max-w-4xl mx-auto p-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (isPublishing()) {
                handlePublish(e);
              } else {
                handleSaveDraft(e);
              }
            }}
            class="grid gap-6"
          >
            {/* Title */}
            <TextField>
              <TextFieldLabel>{t`Title`}</TextFieldLabel>
              <TextFieldInput
                value={title()}
                onInput={(e) => setTitle(e.currentTarget.value)}
                placeholder={t`Please enter a title for your article.`}
                required
                class="text-2xl font-bold"
              />
            </TextField>

            {/* Content */}
            <TextField>
              <TextFieldLabel class="flex items-center justify-between">
                <span>{t`Content`}</span>
                <a
                  href="/markdown"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
                >
                  <svg
                    fill="currentColor"
                    height="128"
                    viewBox="0 0 208 128"
                    width="208"
                    xmlns="http://www.w3.org/2000/svg"
                    class="size-4"
                    stroke="currentColor"
                  >
                    <g>
                      <path
                        clip-rule="evenodd"
                        d="m15 10c-2.7614 0-5 2.2386-5 5v98c0 2.761 2.2386 5 5 5h178c2.761 0 5-2.239 5-5v-98c0-2.7614-2.239-5-5-5zm-15 5c0-8.28427 6.71573-15 15-15h178c8.284 0 15 6.71573 15 15v98c0 8.284-6.716 15-15 15h-178c-8.28427 0-15-6.716-15-15z"
                        fill-rule="evenodd"
                      />
                      <path d="m30 98v-68h20l20 25 20-25h20v68h-20v-39l-20 25-20-25v39zm125 0-30-33h20v-35h20v35h20z" />
                    </g>
                  </svg>
                  {t`Markdown supported`}
                </a>
              </TextFieldLabel>
              <TextFieldTextArea
                value={content()}
                onInput={(e) => setContent(e.currentTarget.value)}
                placeholder={t`Write your article here. You can use Markdown. Your article will be automatically saved as a draft while you're writing.`}
                required
                class="min-h-[400px] font-mono"
              />
            </TextField>

            {/* Tags */}
            <div>
              <label class="text-sm font-medium">{t`Tags`}</label>
              <TagInput
                value={tags()}
                onChange={setTags}
                placeholder={t`Type tags separated by spaces`}
                class="mt-2"
              />
            </div>

            {/* Slug (for publishing) */}
            <Show when={isPublishing()}>
              <TextField>
                <TextFieldLabel>{t`Slug (URL)`}</TextFieldLabel>
                <TextFieldInput
                  value={slug()}
                  onInput={(e) => setSlug(e.currentTarget.value)}
                  placeholder={t`article-url-slug`}
                  required
                />
                <p class="text-xs text-muted-foreground mt-1">
                  {t`This will be part of the article URL`}
                </p>
              </TextField>
            </Show>

            {/* Language (for publishing) */}
            <Show when={isPublishing()}>
              <div>
                <label class="text-sm font-medium">{t`Language`}</label>
                <LanguageSelect
                  value={language()}
                  onChange={handleLanguageChange}
                />
              </div>
            </Show>

            {/* Actions */}
            <div class="flex gap-3 justify-between">
              {/* Delete button (left side) */}
              <Show when={draft()?.id}>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={isDeleting()}
                >
                  {isDeleting() ? t`Deleting...` : t`Delete Draft`}
                </Button>
              </Show>

              {/* Save/Publish buttons (right side) */}
              <div class="flex gap-3 ml-auto">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSaveDraft}
                  disabled={isSaving() || !isDirty()}
                >
                  {isSaving() ? t`Saving...` : t`Save Draft`}
                </Button>

                <Show
                  when={!isPublishing()}
                  fallback={
                    <div class="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setIsPublishing(false)}
                      >
                        {t`Cancel`}
                      </Button>
                      <Button type="submit" disabled={isPublishingMutation()}>
                        {isPublishingMutation()
                          ? t`Publishing...`
                          : t`Publish Now`}
                      </Button>
                    </div>
                  }
                >
                  <Button
                    type="button"
                    onClick={() => setIsPublishing(true)}
                    disabled={!draft()?.id}
                  >
                    {t`Publish Article`}
                  </Button>
                </Show>
              </div>
            </div>
          </form>
        </div>
      </Show>
    </Show>
  );
}
