import { detectLanguage } from "~/lib/langdet.ts";
import { graphql } from "relay-runtime";
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  type ParentComponent,
  useContext,
} from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import { useNavigate } from "@solidjs/router";
import { useAutoSave } from "./useAutoSave.ts";
import { useUnsavedGuard } from "./useUnsavedGuard.ts";
import type { ArticleComposerContextSaveMutation } from "./__generated__/ArticleComposerContextSaveMutation.graphql.ts";
import type { ArticleComposerContextPublishMutation } from "./__generated__/ArticleComposerContextPublishMutation.graphql.ts";
import type { ArticleComposerContextDeleteMutation } from "./__generated__/ArticleComposerContextDeleteMutation.graphql.ts";
import type { ArticleComposerContextDraftQuery as ArticleComposerContextDraftQueryType } from "./__generated__/ArticleComposerContextDraftQuery.graphql.ts";

// --- GraphQL definitions ---

const SaveArticleDraftMutation = graphql`
  mutation ArticleComposerContextSaveMutation(
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
          contentHtml
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
  mutation ArticleComposerContextPublishMutation($input: PublishArticleDraftInput!) {
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
  mutation ArticleComposerContextDeleteMutation(
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
  query ArticleComposerContextDraftQuery($uuid: UUID!) {
    articleDraft(uuid: $uuid) {
      id
      uuid
      title
      content
      tags
    }
  }
`;

// --- Types ---

export interface ArticleComposerProps {
  draftUuid?: string;
  onSaved?: (draftId: string, draftUuid: string) => void;
  onPublished?: (articleUrl: string) => void;
  viewerId?: string;
}

export interface ArticleComposerContextValue {
  // Draft data
  draftUuid: string | undefined;
  draftDataLoaded: Accessor<boolean>;
  draft: Accessor<
    | {
      id: string;
      uuid: string;
      title: string;
      content: string;
      tags: readonly string[];
    }
    | undefined
  >;

  // Form state (read)
  title: Accessor<string>;
  content: Accessor<string>;
  tags: Accessor<string[]>;
  slug: Accessor<string>;
  language: Accessor<Intl.Locale | undefined>;
  isDirty: Accessor<boolean>;
  isPublishing: Accessor<boolean>;
  showPreview: Accessor<boolean>;
  previewHtml: Accessor<string>;

  // Form state (write)
  setTitle: (v: string) => void;
  setContent: (v: string) => void;
  setTags: (v: string[]) => void;
  setSlug: (v: string) => void;
  setLanguage: (locale?: Intl.Locale) => void;
  setIsPublishing: (v: boolean) => void;
  setShowPreview: (v: boolean) => void;

  // Actions
  handleSave: (e?: Event) => void;
  handlePublish: (e: Event) => void;
  handleDelete: () => void;

  // Loading states
  isSaving: Accessor<boolean>;
  isPublishingMutation: Accessor<boolean>;
  isDeleting: Accessor<boolean>;
}

const ArticleComposerContext = createContext<ArticleComposerContextValue>();

// --- Provider ---

export const ArticleComposerProvider: ParentComponent<ArticleComposerProps> = (
  props,
) => {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const env = useRelayEnvironment();

  // Draft loading
  const draftData = props.draftUuid
    ? createPreloadedQuery<ArticleComposerContextDraftQueryType>(
      ArticleComposerDraftQuery,
      () =>
        loadQuery<ArticleComposerContextDraftQueryType>(
          env(),
          ArticleComposerDraftQuery,
          {
            uuid: props
              .draftUuid as `${string}-${string}-${string}-${string}-${string}`,
          },
        ),
    )
    : undefined;

  const draft = createMemo(() => {
    if (!props.draftUuid || !draftData) return undefined;
    return draftData()?.articleDraft ?? undefined;
  });

  const draftDataLoaded = createMemo(() => {
    return !props.draftUuid || !!draftData?.();
  });

  // Form state
  const [title, setTitle] = createSignal("");
  const [content, setContent] = createSignal("");
  const [tags, setTags] = createSignal<string[]>([]);
  const [slug, setSlug] = createSignal("");
  const [language, setLanguageSignal] = createSignal<Intl.Locale | undefined>(
    new Intl.Locale(i18n.locale),
  );
  const [manualLanguageChange, setManualLanguageChange] = createSignal(false);
  const [isPublishing, setIsPublishing] = createSignal(false);

  // Preview state
  const [showPreview, setShowPreview] = createSignal(false);
  const [previewHtml, setPreviewHtml] = createSignal("");

  // Connection IDs for Relay cache updates
  const connectionIds = () => {
    const ids: string[] = [];
    const viewerId = props.viewerId;

    if (viewerId) {
      const sidebarId =
        `client:${viewerId}:__SignedAccount_articleDrafts_connection`;
      const listId =
        `client:${viewerId}:__draftsPaginationFragment_articleDrafts_connection`;
      const floatingButtonId =
        `client:${viewerId}:__FloatingComposeButton_articleDrafts_connection`;

      ids.push(sidebarId);
      ids.push(listId);
      ids.push(floatingButtonId);
    }

    return ids;
  };

  // Mutations
  const [saveDraft, isSaving] = createMutation<
    ArticleComposerContextSaveMutation
  >(
    SaveArticleDraftMutation,
  );
  const [publishDraft, isPublishingMutation] = createMutation<
    ArticleComposerContextPublishMutation
  >(
    PublishArticleDraftMutation,
  );
  const [deleteDraft, isDeleting] = createMutation<
    ArticleComposerContextDeleteMutation
  >(
    DeleteArticleDraftMutation,
  );

  // --- Handlers ---

  const handleSave = (e?: Event) => {
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
          const savedDraft = response.saveArticleDraft.draft;

          setTitle(savedDraft.title);
          setContent(savedDraft.content);
          setTags([...savedDraft.tags]);
          setIsDirty(false);

          if (savedDraft.contentHtml) {
            setPreviewHtml(savedDraft.contentHtml);
          }

          showToast({
            title: t`Success`,
            description: t`Draft saved`,
            variant: "success",
          });
          props.onSaved?.(savedDraft.id, savedDraft.uuid);
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

  // --- Effects ---

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
      setLanguageSignal(new Intl.Locale(detectedLang));
    }
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

  // Language setter that also marks manual change
  const setLanguage = (locale?: Intl.Locale) => {
    setLanguageSignal(locale);
    setManualLanguageChange(true);
  };

  // Auto-save + dirty tracking
  const { isDirty, setIsDirty } = useAutoSave({
    title,
    content,
    tags,
    draft,
    save: handleSave,
    isSaving,
    isPublishing,
  });

  // Navigation guards
  useUnsavedGuard(isDirty);

  // --- Context value ---

  const contextValue: ArticleComposerContextValue = {
    draftUuid: props.draftUuid,
    draftDataLoaded,
    draft,

    title,
    content,
    tags,
    slug,
    language,
    isDirty,
    isPublishing,
    showPreview,
    previewHtml,

    setTitle,
    setContent,
    setTags,
    setSlug,
    setLanguage,
    setIsPublishing,
    setShowPreview,

    handleSave,
    handlePublish,
    handleDelete,

    isSaving,
    isPublishingMutation,
    isDeleting,
  };

  return (
    <ArticleComposerContext.Provider value={contextValue}>
      {props.children}
    </ArticleComposerContext.Provider>
  );
};

// --- Hook ---

export function useArticleComposer(): ArticleComposerContextValue {
  const context = useContext(ArticleComposerContext);
  if (!context) {
    throw new Error(
      "useArticleComposer must be used within ArticleComposerProvider",
    );
  }
  return context;
}
