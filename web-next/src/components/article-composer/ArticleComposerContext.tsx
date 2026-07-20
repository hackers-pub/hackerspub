import { detectLanguage } from "~/lib/langdet.ts";
import { ConnectionHandler, graphql } from "relay-runtime";
import {
  type Accessor,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  type ParentComponent,
  useContext,
} from "solid-js";
import { isServer } from "solid-js/web";
import { createMutation, loadQuery, useRelayEnvironment } from "solid-relay";
import { createStablePreloadedQuery } from "~/lib/relayPreload.ts";
import { showToast } from "~/components/ui/toast.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import {
  PERSONAL_COMPOSE_ACCOUNT_KEY,
  useActingAccount,
} from "~/contexts/ActingAccountContext.tsx";
import { getBrowserLocalStorage } from "~/lib/browserStorage.ts";
import {
  buildNoteDraftContentFromArticle,
  shouldSuggestNoteForArticle,
} from "~/lib/formatGuidance.ts";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import {
  getNoteDraftStorageKey,
  readNoteDraft,
  writeNoteDraft,
} from "~/lib/noteDraftStorage.ts";
import { publishNoteDraftChange } from "~/lib/noteDraftSync.ts";
import { decodeRouteParam } from "~/lib/routeParam.ts";
import { useNavigate, useParams } from "@solidjs/router";
import {
  createDraftFormSnapshot,
  createDraftSaveInput,
  reconcileDraftSaveResponse,
} from "./draftSaveSnapshot.ts";
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
      contentHtml
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
  draftUuid: string;
  existingDraft: boolean;
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
  quotePolicy: Accessor<QuotePolicy>;
  publishActingAccountKey: Accessor<string>;
  allowLlmTranslation: Accessor<boolean>;
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
  setQuotePolicy: (v: QuotePolicy) => void;
  setPublishActingAccountKey: (v: string) => void;
  setAllowLlmTranslation: (v: boolean) => void;
  setIsPublishing: (v: boolean) => void;
  setShowPreview: (v: boolean) => void;

  // Actions
  handleSave: (e?: Event, silent?: boolean, afterSave?: () => void) => void;
  handlePublish: (e?: Event) => void;
  publishArticleAnyway: () => void;
  saveAsNoteDraft: (replaceExisting?: boolean) => void;
  handleDelete: () => void;
  /**
   * Advance from the writing stage to the publish-settings stage, persisting any
   * unsaved changes first so the draft exists and its `id` is available.
   */
  goToPublishSettings: () => void;

  // Loading states
  isSaving: Accessor<boolean>;
  isPublishingMutation: Accessor<boolean>;
  isDeleting: Accessor<boolean>;
  showShortArticleSuggestion: Accessor<boolean>;
  setShowShortArticleSuggestion: (v: boolean) => void;
  showReplaceNoteDraftConfirm: Accessor<boolean>;
  setShowReplaceNoteDraftConfirm: (v: boolean) => void;
}

const ArticleComposerContext = createContext<ArticleComposerContextValue>();

type DraftState = NonNullable<ReturnType<ArticleComposerContextValue["draft"]>>;

// --- Provider ---

export const ArticleComposerProvider: ParentComponent<ArticleComposerProps> = (
  props,
) => {
  const { t, i18n } = useLingui();
  const actingAccount = useActingAccount();
  const navigate = useNavigate();
  const params = useParams();
  const env = useRelayEnvironment();
  const draftUuid = (props.draftUuid ??
    crypto
      .randomUUID()) as `${string}-${string}-${string}-${string}-${string}`;

  // Draft loading
  const draftData = props.draftUuid
    ? createStablePreloadedQuery<ArticleComposerContextDraftQueryType>(
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

  const loadedDraft = createMemo(() => {
    if (!props.draftUuid || !draftData) return undefined;
    return draftData()?.articleDraft ?? undefined;
  });
  const [savedDraft, setSavedDraft] = createSignal<DraftState | undefined>();
  const draft = createMemo(() => savedDraft() ?? loadedDraft());

  const draftDataLoaded = createMemo(() => {
    // When editing an existing draft the Relay store starts empty on the
    // client, so draftData() is initially undefined there while the server
    // already has the data. Returning false on the server for this case
    // keeps the initial render consistent (both sides show the loading
    // state) and avoids a hydration mismatch.
    if (props.draftUuid && isServer) return false;
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
  const [quotePolicy, setQuotePolicy] = createSignal<QuotePolicy>("EVERYONE");
  const [publishActingAccountKey, setPublishActingAccountKey] = createSignal(
    PERSONAL_COMPOSE_ACCOUNT_KEY,
  );
  const [allowLlmTranslation, setAllowLlmTranslation] = createSignal(true);
  const [manualLanguageChange, setManualLanguageChange] = createSignal(false);
  const [manualSlugChange, setManualSlugChange] = createSignal(false);
  const [isPublishing, setIsPublishing] = createSignal(false);
  const [showShortArticleSuggestion, setShowShortArticleSuggestion] =
    createSignal(false);
  const [showReplaceNoteDraftConfirm, setShowReplaceNoteDraftConfirm] =
    createSignal(false);
  const noteDraftSyncOrigin = Symbol("ArticleComposer");

  // Preview state
  const [showPreview, setShowPreview] = createSignal(false);
  const [previewHtml, setPreviewHtml] = createSignal("");

  const draftConnections = () => {
    const viewerId = props.viewerId;
    if (viewerId == null) return [];

    return [
      "SignedAccount_articleDrafts",
      "draftsPaginationFragment_articleDrafts",
      "FloatingComposeButton_articleDrafts",
    ].map((connectionKey) =>
      ConnectionHandler.getConnectionID(viewerId, connectionKey)
    );
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

  const handleSave = (e?: Event, silent?: boolean, afterSave?: () => void) => {
    e?.preventDefault();

    if (!title().trim()) {
      if (!silent) {
        showToast({
          title: t`Error`,
          description: t`Title cannot be empty`,
          variant: "error",
        });
      }
      return;
    }

    const submittedForm = createDraftFormSnapshot(
      title(),
      content(),
      tags(),
    );
    const submittedDraft = createDraftSaveInput(submittedForm);

    saveDraft({
      variables: {
        input: {
          id: draft()?.id,
          uuid: draft()?.id == null ? draftUuid : undefined,
          title: submittedDraft.title,
          content: submittedDraft.content,
          tags: submittedDraft.tags,
        },
        connections: draftConnections(),
      },
      onCompleted(response) {
        if (
          response.saveArticleDraft.__typename === "SaveArticleDraftPayload"
        ) {
          const savedDraft = response.saveArticleDraft.draft;
          const currentForm = createDraftFormSnapshot(
            title(),
            content(),
            tags(),
          );
          const savedForm = createDraftFormSnapshot(
            savedDraft.title,
            savedDraft.content,
            savedDraft.tags,
          );
          const { formReconciled, baseline } = reconcileDraftSaveResponse(
            currentForm,
            submittedForm,
            savedForm,
          );

          setSavedDraft({
            id: savedDraft.id,
            uuid: savedDraft.uuid,
            title: baseline.title,
            content: baseline.content,
            tags: [...baseline.tags],
          });

          if (formReconciled) {
            setIsDirty(false);
          } else {
            setIsDirty(true);
          }

          if (savedDraft.contentHtml) {
            setPreviewHtml(savedDraft.contentHtml);
          }

          if (!silent) {
            showToast({
              title: t`Success`,
              description: t`Draft saved`,
              variant: "success",
            });
          }
          if (formReconciled) {
            props.onSaved?.(savedDraft.id, savedDraft.uuid);
            // Only continue (e.g. advance to publish, or publish now) when the
            // form still matches what was submitted or has converged to the
            // saved response. Otherwise the user has newer unsaved changes,
            // so skip the follow-up rather than acting on a stale draft.
            afterSave?.();
          }
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

  const handlePublish = (e?: Event) => {
    e?.preventDefault();

    if (shouldSuggestNoteForArticle(content())) {
      setShowShortArticleSuggestion(true);
      return;
    }

    publishArticleAnyway();
  };

  const publishArticleAnyway = () => {
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

    // Tags are only persisted via `saveDraft` (the publish input doesn't carry
    // them) and Stage 2 pauses autosave, so flush any pending edits first, then
    // publish once the save lands.
    if (isDirty()) {
      handleSave(undefined, true, publishNow);
    } else {
      publishNow();
    }
  };

  const getBrowserDraftStorage = getBrowserLocalStorage;

  const getRouteUsername = () => {
    const handle = params.handle;
    return handle == null ? null : decodeRouteParam(handle).substring(1);
  };

  const saveAsNoteDraft = (replaceExisting = false) => {
    const username = getRouteUsername();
    if (username == null) {
      showToast({
        title: t`Error`,
        description: t`You must be signed in to save a draft`,
        variant: "error",
      });
      return;
    }

    const scope = { type: "new" } as const;
    const key = getNoteDraftStorageKey(username, scope);
    const storage = getBrowserDraftStorage();
    if (readNoteDraft(storage, key) != null && !replaceExisting) {
      setShowShortArticleSuggestion(false);
      setShowReplaceNoteDraftConfirm(true);
      return;
    }

    const result = writeNoteDraft(storage, key, scope, {
      content: buildNoteDraftContentFromArticle(title(), content()),
      language: language()?.baseName,
      visibility: "PUBLIC",
      quotePolicy: quotePolicy(),
      actingAccountKey: publishActingAccountKey(),
      media: [],
      poll: {
        enabled: false,
        title: "",
        multiple: false,
        ends: "",
        options: [
          { localId: crypto.randomUUID(), title: "" },
          { localId: crypto.randomUUID(), title: "" },
        ],
      },
      updated: new Date().toISOString(),
    });

    if (result !== "ok") {
      showToast({
        title: t`Error`,
        description: t`Local draft could not be saved`,
        variant: "error",
      });
      return;
    }

    publishNoteDraftChange({ key, origin: noteDraftSyncOrigin });
    setIsDirty(false);
    setShowShortArticleSuggestion(false);
    setShowReplaceNoteDraftConfirm(false);
    showToast({
      title: t`Success`,
      description: t`Local draft saved`,
      variant: "success",
    });
    navigate("/feed?compose=note");
  };

  const publishNow = () => {
    publishDraft({
      variables: {
        input: {
          id: draft()!.id,
          slug: slug().trim(),
          language: language()?.baseName ?? i18n.locale,
          allowLlmTranslation: allowLlmTranslation(),
          quotePolicy: quotePolicy(),
          ...actingAccount.composeInputForKey(publishActingAccountKey()),
        },
      },
      onCompleted(response) {
        if (
          response.publishArticleDraft.__typename ===
            "PublishArticleDraftPayload"
        ) {
          const articleUrl = response.publishArticleDraft.article.url!;
          navigate(new URL(articleUrl).pathname);
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
        connections: draftConnections(),
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

  const goToPublishSettings = () => {
    if (!title().trim()) {
      showToast({
        title: t`Error`,
        description: t`Title cannot be empty`,
        variant: "error",
      });
      return;
    }

    if (isDirty()) {
      handleSave(undefined, true, () => setIsPublishing(true));
    } else {
      setIsPublishing(true);
    }
  };

  // --- Effects ---

  const [hydratedDraft, setHydratedDraft] = createSignal(false);

  // Populate form when the initial draft loads. Later save responses update
  // the saved baseline, but must not overwrite text the user typed while the
  // request was in flight.
  createEffect(() => {
    const currentDraft = loadedDraft();
    if (currentDraft && !hydratedDraft()) {
      setSavedDraft(currentDraft);
      setTitle(currentDraft.title);
      setContent(currentDraft.content);
      setTags([...currentDraft.tags]);
      // Seed the preview so an existing draft shows rendered content
      // immediately (the desktop side-by-side preview otherwise stays empty
      // until the first autosave).
      if (currentDraft.contentHtml) setPreviewHtml(currentDraft.contentHtml);
      setHydratedDraft(true);
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

  createEffect(
    on(
      () => actingAccount.defaultComposeAccountKey(),
      (defaultKey) => setPublishActingAccountKey(defaultKey),
    ),
  );

  createEffect(() => {
    if (
      publishActingAccountKey() !== PERSONAL_COMPOSE_ACCOUNT_KEY &&
      actingAccount.composeInputForKey(publishActingAccountKey())
          .actingAccountId == null
    ) {
      setPublishActingAccountKey(actingAccount.defaultComposeAccountKey());
    }
  });

  // Auto-generate slug from title (only while user hasn't manually touched it)
  createEffect(() => {
    const titleValue = title();
    if (titleValue && !manualSlugChange()) {
      const autoSlug = titleValue
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 128);
      setSlug(autoSlug);
    }
  });

  const handleSetSlug = (v: string) => {
    setManualSlugChange(true);
    setSlug(v);
  };

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
    save: (silent) => handleSave(undefined, silent),
    isSaving,
    isPublishing,
  });

  // Navigation guards
  useUnsavedGuard(isDirty);

  // --- Context value ---

  const contextValue: ArticleComposerContextValue = {
    draftUuid,
    existingDraft: props.draftUuid != null,
    draftDataLoaded,
    draft,

    title,
    content,
    tags,
    slug,
    language,
    quotePolicy,
    publishActingAccountKey,
    allowLlmTranslation,
    isDirty,
    isPublishing,
    showPreview,
    previewHtml,

    setTitle,
    setContent,
    setTags,
    setSlug: handleSetSlug,
    setLanguage,
    setQuotePolicy,
    setPublishActingAccountKey,
    setAllowLlmTranslation,
    setIsPublishing,
    setShowPreview,

    handleSave,
    handlePublish,
    publishArticleAnyway,
    saveAsNoteDraft,
    handleDelete,
    goToPublishSettings,

    isSaving,
    isPublishingMutation,
    isDeleting,
    showShortArticleSuggestion,
    setShowShortArticleSuggestion,
    showReplaceNoteDraftConfirm,
    setShowReplaceNoteDraftConfirm,
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
