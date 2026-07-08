import { useNavigate } from "@solidjs/router";
import { ConnectionHandler, fetchQuery, graphql } from "relay-runtime";
import { createStore, produce } from "solid-js/store";
import IconFileText from "~icons/lucide/file-text";
import IconImage from "~icons/lucide/image";
import IconListChecks from "~icons/lucide/list-checks";
import IconPlus from "~icons/lucide/plus";
import IconSquare from "~icons/lucide/square";
import IconTrash from "~icons/lucide/trash-2";
import IconX from "~icons/lucide/x";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { createMutation, useRelayEnvironment } from "solid-relay";
import { ensureLinkInContent } from "~/lib/composerLink.ts";
import { encodeHandleSegment } from "~/lib/handleSegment.ts";
import { detectLanguage } from "~/lib/langdet.ts";
import { shouldSuggestArticleForNote } from "~/lib/formatGuidance.ts";
import {
  getNoteDraftStorageKey,
  isMeaningfulNoteDraft,
  type NoteDraftData,
  type NoteDraftMedia,
  type NoteDraftScope,
  readNoteDraft,
  removeNoteDraft,
  type StoredNoteDraft,
  writeNoteDraft,
} from "~/lib/noteDraftStorage.ts";
import {
  publishNoteDraftChange,
  registerNoteDraftFlush,
  subscribeNoteDraftChanges,
} from "~/lib/noteDraftSync.ts";
import {
  UploadAbortedError,
  uploadMediumFile,
} from "~/lib/uploadMediumWithProgress.ts";
import {
  ActingAccountSelect,
  useComposeActingAccountOptions,
} from "~/components/ActingAccountSelect.tsx";
import { LanguageSelect } from "~/components/LanguageSelect.tsx";
import { MentionAutocomplete } from "~/components/MentionAutocomplete.tsx";
import { NoteVisibilityQuotePolicySelect } from "~/components/NoteVisibilityQuotePolicySelect.tsx";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "~/components/ui/avatar.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog.tsx";
import { Button } from "~/components/ui/button.tsx";
import { MarkdownEditor } from "~/components/MarkdownEditor.tsx";
import { TextField, TextFieldLabel } from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import {
  PERSONAL_COMPOSE_ACCOUNT_KEY,
  useActingAccount,
} from "~/contexts/ActingAccountContext.tsx";
import { useViewer } from "~/contexts/ViewerContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import type { NoteComposerGeneratedAltTextQuery } from "./__generated__/NoteComposerGeneratedAltTextQuery.graphql.ts";
import type { NoteComposerArticleDraftMutation } from "./__generated__/NoteComposerArticleDraftMutation.graphql.ts";
import type { NoteComposerMutation } from "./__generated__/NoteComposerMutation.graphql.ts";
import type { NoteComposerDraftMediaQuery } from "./__generated__/NoteComposerDraftMediaQuery.graphql.ts";
import type { NoteComposerPostByUrlQuery } from "./__generated__/NoteComposerPostByUrlQuery.graphql.ts";
import type { NoteComposerQuestionMutation } from "./__generated__/NoteComposerQuestionMutation.graphql.ts";
import type { NoteComposerQuotedPostQuery } from "./__generated__/NoteComposerQuotedPostQuery.graphql.ts";
import type { NoteComposerReplyTargetQuery } from "./__generated__/NoteComposerReplyTargetQuery.graphql.ts";
import type { NoteComposerUpdateMutation } from "./__generated__/NoteComposerUpdateMutation.graphql.ts";

const NoteComposerMutation = graphql`
  mutation NoteComposerMutation(
    $input: CreateNoteInput!
    $connections: [ID!]!
    $includeDiscussionThreadFields: Boolean!
    $actingAccountId: ID
  ) {
    createNote(input: $input) {
      __typename
      ... on CreateNotePayload {
        note
          @prependNode(
            connections: $connections
            edgeTypeName: "PostLinkSharingPostsConnectionEdge"
          ) {
          id
          uuid
          sourceId
          actor {
            handle
            username
            local
          }
          # Only news-discussion posts prepend into a connection and need the
          # row fields; skip them for every other compose/reply/quote path.
          ...NewsDiscussionThread_post
            @arguments(actingAccountId: $actingAccountId)
            @include(if: $includeDiscussionThreadFields)
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

const NoteComposerQuestionMutation = graphql`
  mutation NoteComposerQuestionMutation(
    $input: CreateQuestionInput!
    $connections: [ID!]!
    $includeDiscussionThreadFields: Boolean!
    $actingAccountId: ID
  ) {
    createQuestion(input: $input) {
      __typename
      ... on CreateQuestionPayload {
        question
          @prependNode(
            connections: $connections
            edgeTypeName: "PostLinkSharingPostsConnectionEdge"
          ) {
          id
          ...NewsDiscussionThread_post
            @arguments(actingAccountId: $actingAccountId)
            @include(if: $includeDiscussionThreadFields)
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

const NoteComposerUpdateMutation = graphql`
  mutation NoteComposerUpdateMutation($input: UpdateNoteInput!) {
    updateNote(input: $input) {
      __typename
      ... on UpdateNotePayload {
        note {
          id
          content
          rawContent
          language
          quotePolicy
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

const NoteComposerArticleDraftMutation = graphql`
  mutation NoteComposerArticleDraftMutation(
    $input: SaveArticleDraftInput!
    $connections: [ID!]!
  ) {
    saveArticleDraft(input: $input) {
      __typename
      ... on SaveArticleDraftPayload {
        draft
          @prependNode(
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

const NoteComposerDraftMediaQuery = graphql`
  query NoteComposerDraftMediaQuery($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Medium {
        id
        uuid
        url
        width
        height
      }
    }
  }
`;

const NoteComposerQuotedPostQuery = graphql`
  query NoteComposerQuotedPostQuery($id: ID!) {
    node(id: $id) {
      ... on Note {
        __typename
        excerpt
        actor {
          rawName
          handle
          avatarUrl
        }
      }
      ... on Article {
        __typename
        name
        excerpt
        actor {
          rawName
          handle
          avatarUrl
        }
      }
      ... on Question {
        __typename
        excerpt
        actor {
          rawName
          handle
          avatarUrl
        }
      }
    }
  }
`;

const NoteComposerReplyTargetQuery = graphql`
  query NoteComposerReplyTargetQuery($id: ID!) {
    viewer {
      actor {
        id
      }
    }
    node(id: $id) {
      ... on Note {
        __typename
        excerpt
        actor {
          id
          rawName
          handle
          avatarUrl
        }
        mentions {
          edges {
            node {
              id
              handle
            }
          }
        }
      }
      ... on Article {
        __typename
        name
        excerpt
        actor {
          id
          rawName
          handle
          avatarUrl
        }
        mentions {
          edges {
            node {
              id
              handle
            }
          }
        }
      }
      ... on Question {
        __typename
        excerpt
        actor {
          id
          rawName
          handle
          avatarUrl
        }
        mentions {
          edges {
            node {
              id
              handle
            }
          }
        }
      }
    }
  }
`;

const NoteComposerPostByUrlQuery = graphql`
  query NoteComposerPostByUrlQuery($url: String!, $actingAccountId: ID) {
    postByUrl(url: $url, actingAccountId: $actingAccountId) {
      __typename
      id
      viewerCanQuote(actingAccountId: $actingAccountId)
    }
  }
`;

const NoteComposerGeneratedAltTextQuery = graphql`
  query NoteComposerGeneratedAltTextQuery(
    $mediumId: ID!
    $language: Locale!
    $context: String
  ) {
    node(id: $mediumId) {
      ... on Medium {
        generatedAltText(language: $language, context: $context)
      }
    }
  }
`;

const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const MAX_MEDIA = 20;
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 20;

interface PollOptionDraft {
  localId: string;
  title: string;
}

interface ValidatedPollInput {
  title: string;
  multiple: boolean;
  options: string[];
  ends: string;
}

function createLocalId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2);
}

function formatDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${
    pad(date.getDate())
  }T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocal(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match == null) return new Date(NaN);
  const [, year, month, day, hours, minutes] = match.map(Number);
  const date = new Date(year, month - 1, day, hours, minutes);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes
  ) {
    return new Date(NaN);
  }
  return date;
}

function defaultPollEnds(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setSeconds(0, 0);
  return formatDateTimeLocal(date);
}

interface MediaItem {
  localId: string;
  file?: File;
  previewUrl: string;
  alt: string;
  mediumRelayId?: string;
  uuid?: string;
  url?: string;
  width?: number;
  height?: number;
  uploading: boolean;
  uploadProgress: number;
  generatingAlt: boolean;
  abortUpload?: () => void;
  altSubscription?: { unsubscribe: () => void };
}

interface QuotedPostPreview {
  typename: "Note" | "Article" | "Question";
  excerpt: string;
  name?: string;
  actorName?: string;
  actorHandle: string;
  actorAvatarUrl: string;
}

export type NoteDraftFlush = () => boolean;

function revokePreviewUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

export interface NoteComposerProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  onContentChange?: (isDirty: boolean) => void;
  onDraftFlushAvailable?: (flush: NoteDraftFlush | null) => void;
  showCancelButton?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  class?: string;
  quotedPostId?: string | null;
  onQuoteRemoved?: () => void;
  replyTargetId?: string | null;
  defaultVisibility?: PostVisibility | null;
  showReplyTarget?: boolean;
  // When set (new notes only), the URL is appended to the bottom of the
  // submitted content unless the author already included it, so the note links
  // to (and joins the discussion of) this URL.
  ensureLinkUrl?: string | null;
  // New notes only: Relay connection record ids to prepend the created note's
  // edge into, so the new note appears in those lists without a refetch.
  prependToConnections?: string[];
  // New notes only: controls browser-side local draft reads and writes. Modal
  // composers stay mounted while closed, so they disable this when hidden.
  draftActive?: boolean;
  // New notes only: hide the poll composer in surfaces whose optimistic or
  // inline render path cannot display a `Question` poll yet.
  allowPoll?: boolean;
  // Edit mode: when set, the composer updates an existing note instead of
  // creating a new one.
  editingNoteId?: string | null;
  initialContent?: string | null;
  initialLanguage?: string | null;
  initialQuotePolicy?: QuotePolicy | null;
  editingVisibility?: PostVisibility | null;
  editingAuthorAccountId?: string | null;
}

export function NoteComposer(props: NoteComposerProps) {
  const { t, i18n } = useLingui();
  const viewer = useViewer();
  const actingAccount = useActingAccount();
  const composeActingAccountOptions = useComposeActingAccountOptions();
  const environment = useRelayEnvironment();
  const navigate = useNavigate();
  // Initialize content directly from props so a deliberate pre-fill — an edit's
  // body, or a "share this link" URL passed via `initialContent` — is present
  // on the first render (avoids an async createEffect lag).  Empty for a plain
  // compose / reply / quote, where `initialContent` is null.
  const initialEditContent = props.initialContent ?? "";
  const [content, setContent] = createSignal(initialEditContent);
  const [visibility, setVisibility] = createSignal<PostVisibility>(
    props.defaultVisibility ?? "PUBLIC",
  );
  const [quotePolicy, setQuotePolicy] = createSignal<QuotePolicy>(
    props.editingNoteId
      ? ((props.initialQuotePolicy as QuotePolicy | null | undefined) ??
        "EVERYONE")
      : "EVERYONE",
  );
  // Keep visibility in sync when the modal is reused for a different reply/quote
  createEffect(() => {
    const v = props.defaultVisibility;
    if (v != null) setVisibility(v);
  });
  // In edit mode, use the note's original visibility (immutable) to determine
  // whether the quote policy is applicable; visibility() may hold a stale
  // value from a previous create/reply use of the same component instance.
  const effectiveQuotePolicy = () => {
    const vis = props.editingNoteId
      ? (props.editingVisibility ?? "PUBLIC")
      : visibility();
    return vis === "PUBLIC" || vis === "UNLISTED" ? quotePolicy() : "SELF";
  };
  const [language, setLanguage] = createSignal<Intl.Locale | undefined>(
    props.editingNoteId && props.initialLanguage
      ? new Intl.Locale(props.initialLanguage)
      : new Intl.Locale(i18n.locale),
  );
  const [manualLanguageChange, setManualLanguageChange] = createSignal(
    !!props.editingNoteId,
  );
  const [actingAccountKey, setActingAccountKey] = createSignal(
    PERSONAL_COMPOSE_ACCOUNT_KEY,
  );
  const selectedActingAccountOption = createMemo(() =>
    composeActingAccountOptions().find((option) =>
      option.value === actingAccountKey()
    )
  );

  createEffect(
    on(
      () => actingAccount.defaultComposeAccountKey(),
      (defaultKey) => {
        if (!props.editingNoteId) setActingAccountKey(defaultKey);
      },
    ),
  );

  createEffect(() => {
    if (props.editingNoteId) {
      setActingAccountKey(PERSONAL_COMPOSE_ACCOUNT_KEY);
      return;
    }
    const options = composeActingAccountOptions();
    if (options.length === 0) return;
    if (!options.some((option) => option.value === actingAccountKey())) {
      setActingAccountKey(actingAccount.defaultComposeAccountKey());
    }
  });

  const actingAccountInput = () =>
    selectedActingAccountOption() == null
      ? {}
      : actingAccount.composeInputForKey(actingAccountKey());
  const editActingAccountInput = () =>
    props.editingAuthorAccountId == null
      ? {}
      : { actingAccountId: props.editingAuthorAccountId };
  const allowPoll = () => props.allowPoll !== false;
  const canCreatePoll = () => !props.editingNoteId && allowPoll();
  const [pastedQuoteId, setPastedQuoteId] = createSignal<string | null>(null);
  const effectiveQuotedPostId = () => props.quotedPostId ?? pastedQuoteId();
  const [quotedPost, setQuotedPost] = createSignal<
    QuotedPostPreview | null
  >(null);
  const [quoteFetchError, setQuoteFetchError] = createSignal(false);
  const [replyTargetPost, setReplyTargetPost] = createSignal<
    QuotedPostPreview | null
  >(null);
  const [replyTargetFetchError, setReplyTargetFetchError] = createSignal(false);
  // Tracks the currently pre-filled mention string so we can detect whether
  // the user has edited the content away from the auto-fill.
  let prefillRef = initialEditContent;
  let replyPrefillTargetId: string | null = null;

  // When edit mode is (re-)activated, sync form state from the new props.
  // The `on()` helper ensures this only re-runs when editingNoteId changes,
  // and reads the other props without tracking them — preventing form resets
  // while the user types.
  createEffect(
    on(
      () => props.editingNoteId,
      (id) => {
        if (!id) return;
        const c = props.initialContent ?? "";
        const lang = props.initialLanguage;
        const qp = props.initialQuotePolicy;
        prefillRef = c;
        setContent(c);
        // Always update language in edit mode; null means "no language set".
        setLanguage(lang ? new Intl.Locale(lang) : undefined);
        setManualLanguageChange(true);
        if (qp) setQuotePolicy(qp as QuotePolicy);
        replyPrefillTargetId = null;
        setEditorResetKey((k) => k + 1);
      },
    ),
  );

  const [createNote, isCreating] = createMutation<NoteComposerMutation>(
    NoteComposerMutation,
  );
  const [createQuestion, isCreatingQuestion] = createMutation<
    NoteComposerQuestionMutation
  >(
    NoteComposerQuestionMutation,
  );
  const [updateNote, isUpdating] = createMutation<NoteComposerUpdateMutation>(
    NoteComposerUpdateMutation,
  );
  const [saveArticleDraft, isSavingArticleDraft] = createMutation<
    NoteComposerArticleDraftMutation
  >(
    NoteComposerArticleDraftMutation,
  );
  const [mediaItems, setMediaItems] = createStore<MediaItem[]>([]);
  const [pollOptions, setPollOptions] = createStore<PollOptionDraft[]>([
    { localId: createLocalId(), title: "" },
    { localId: createLocalId(), title: "" },
  ]);
  const [pollEnabled, setPollEnabled] = createSignal(false);
  const [pollTitle, setPollTitle] = createSignal("");
  const [pollMultiple, setPollMultiple] = createSignal(false);
  const [pollEnds, setPollEnds] = createSignal(defaultPollEnds());
  const [isDraggingOver, setIsDraggingOver] = createSignal(false);
  const [editorResetKey, setEditorResetKey] = createSignal(0);
  let formRef: HTMLFormElement | undefined;
  let removeDragListeners: (() => void) | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let saveDraftTimer: ReturnType<typeof setTimeout> | undefined;
  let draftRestoreMediaSubscription:
    | { unsubscribe: () => void }
    | undefined;
  let restoringDraft = false;
  let formDraftKey: string | null = null;
  let unregisterDraftFlush: (() => void) | undefined;
  const draftSyncOrigin = Symbol("NoteComposer");

  const draftScope = createMemo<NoteDraftScope | null>(() => {
    if (props.editingNoteId) return null;
    if (props.replyTargetId) {
      return { type: "reply", targetId: props.replyTargetId };
    }
    const quoteId = props.quotedPostId;
    if (quoteId) return { type: "quote", targetId: quoteId };
    if (props.ensureLinkUrl) return { type: "link", url: props.ensureLinkUrl };
    const initial = props.initialContent?.trim();
    if (initial) return { type: "prefill", content: initial };
    return { type: "new" };
  });
  const draftStorageKey = createMemo(() => {
    if (props.draftActive === false) return null;
    const scope = draftScope();
    const username = viewer.username();
    if (scope == null || username == null) return null;
    return getNoteDraftStorageKey(username, scope);
  });
  const [loadedDraftKey, setLoadedDraftKey] = createSignal<string | null>(null);
  const [hasLocalDraft, setHasLocalDraft] = createSignal(false);
  const [draftSaveStatus, setDraftSaveStatus] = createSignal<
    "idle" | "saved" | "unavailable"
  >("idle");
  const [showDeleteDraftConfirm, setShowDeleteDraftConfirm] = createSignal(
    false,
  );
  const [showArticleSuggestion, setShowArticleSuggestion] = createSignal(
    false,
  );
  const [articleSuggestionDismissed, setArticleSuggestionDismissed] =
    createSignal(false);
  const [showArticleSwitchButton, setShowArticleSwitchButton] = createSignal(
    false,
  );

  onCleanup(() => {
    saveCurrentDraftNow();
    props.onDraftFlushAvailable?.(null);
    unregisterDraftFlush?.();
    removeDragListeners?.();
    clearTimeout(saveDraftTimer);
    draftRestoreMediaSubscription?.unsubscribe();
    for (const item of mediaItems) {
      item.abortUpload?.();
      item.altSubscription?.unsubscribe();
      revokePreviewUrl(item.previewUrl);
    }
  });

  // In edit mode treat any divergence from the original as dirty, including
  // clearing all content.  In compose mode keep the original guard so an
  // empty textarea isn't flagged dirty on first render.
  const isDirty = createMemo(() => {
    const contentDirty = props.editingNoteId
      ? content().trim() !== prefillRef.trim()
      : content().trim() !== "" && content().trim() !== prefillRef.trim();
    const editMetaDirty = !!props.editingNoteId && (
      language()?.baseName !== (props.initialLanguage ?? undefined) ||
      quotePolicy() !== (props.initialQuotePolicy ?? "EVERYONE")
    );
    const pollDirty = canCreatePoll() && pollEnabled();
    return contentDirty || mediaItems.length > 0 || editMetaDirty || pollDirty;
  });
  createEffect(() => props.onContentChange?.(isDirty()));
  const isSubmitting = () =>
    isCreating() || isCreatingQuestion() ||
    isUpdating() || isSavingArticleDraft();
  const isPlainNewNote = () =>
    !props.editingNoteId &&
    !props.replyTargetId &&
    !props.quotedPostId &&
    !props.ensureLinkUrl &&
    !props.initialContent &&
    effectiveQuotedPostId() == null;
  const canSwitchToArticle = () =>
    isPlainNewNote() &&
    mediaItems.length === 0 &&
    !pollEnabled() &&
    content().trim() !== "";
  const articleDraftConnections = () => {
    const viewerId = viewer.id();
    if (viewerId == null) return [];
    return [
      "SignedAccount_articleDrafts",
      "draftsPaginationFragment_articleDrafts",
      "FloatingComposeButton_articleDrafts",
    ].map((connectionKey) =>
      ConnectionHandler.getConnectionID(viewerId, connectionKey)
    );
  };

  const getBrowserDraftStorage = () => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  };

  createEffect(() => {
    if (
      !canSwitchToArticle() ||
      articleSuggestionDismissed() ||
      showArticleSuggestion()
    ) {
      return;
    }
    if (shouldSuggestArticleForNote(content())) {
      setShowArticleSuggestion(true);
    }
  });

  const dismissArticleSuggestion = () => {
    setShowArticleSuggestion(false);
    setArticleSuggestionDismissed(true);
    setShowArticleSwitchButton(true);
  };

  const switchToArticleDraft = () => {
    const username = viewer.username();
    const draftContent = content().trim();
    if (username == null) {
      showToast({
        title: t`Error`,
        description: t`You must be signed in to save a draft`,
        variant: "error",
      });
      return;
    }
    if (!canSwitchToArticle() || draftContent === "") {
      setShowArticleSuggestion(false);
      return;
    }

    saveCurrentDraftNow();
    saveArticleDraft({
      variables: {
        input: {
          title: "",
          content: draftContent,
          tags: [],
        },
        connections: articleDraftConnections(),
      },
      onCompleted(response) {
        if (
          response.saveArticleDraft.__typename === "SaveArticleDraftPayload"
        ) {
          const draft = response.saveArticleDraft.draft;
          clearCurrentDraft();
          resetForm();
          setShowArticleSuggestion(false);
          setShowArticleSwitchButton(false);
          showToast({
            title: t`Success`,
            description: t`Draft saved`,
            variant: "success",
          });
          navigate(
            `/@${encodeHandleSegment(username)}/drafts/${draft.uuid}`,
          );
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

  const currentDraftData = (): NoteDraftData => ({
    content: content(),
    language: language()?.baseName,
    visibility: visibility(),
    quotePolicy: quotePolicy(),
    actingAccountKey: actingAccountKey(),
    quotedPostId: effectiveQuotedPostId() ?? undefined,
    replyTargetId: props.replyTargetId ?? undefined,
    ensureLinkUrl: props.ensureLinkUrl ?? undefined,
    media: mediaItems
      .filter((item) =>
        item.uuid != null && item.mediumRelayId != null &&
        (item.url != null || !item.previewUrl.startsWith("blob:"))
      )
      .map((item): NoteDraftMedia => ({
        localId: item.localId,
        mediumRelayId: item.mediumRelayId!,
        uuid: item.uuid!,
        url: item.url ?? item.previewUrl,
        alt: item.alt,
        width: item.width,
        height: item.height,
      })),
    poll: {
      enabled: canCreatePoll() && pollEnabled(),
      title: pollTitle(),
      multiple: pollMultiple(),
      ends: pollEnds(),
      options: pollOptions.map((option) => ({
        localId: option.localId,
        title: option.title,
      })),
    },
    updatedAt: new Date().toISOString(),
  });

  const currentStorableDraftData = (): NoteDraftData => {
    const draft = currentDraftData();
    if (isDirty()) return draft;
    return {
      ...draft,
      content: "",
      media: [],
      poll: {
        ...draft.poll,
        enabled: false,
      },
    };
  };

  const hasUnstorableMedia = () =>
    mediaItems.some((item) =>
      item.uploading ||
      item.uuid == null ||
      item.mediumRelayId == null ||
      (item.url == null && item.previewUrl.startsWith("blob:"))
    );

  const currentDraftIsMeaningful = createMemo(() =>
    !props.editingNoteId && isMeaningfulNoteDraft(currentStorableDraftData())
  );

  const saveCurrentDraftNow = (): boolean => {
    const key = draftStorageKey();
    const scope = draftScope();
    if (
      key == null || scope == null || loadedDraftKey() !== key ||
      restoringDraft
    ) {
      return !isDirty();
    }

    clearTimeout(saveDraftTimer);
    const draft = currentStorableDraftData();
    const hasMediaNotInDraft = hasUnstorableMedia();
    const result = writeNoteDraft(getBrowserDraftStorage(), key, scope, draft);
    setHasLocalDraft(result === "ok");
    if (result === "ok") {
      formDraftKey = key;
      setDraftSaveStatus(hasMediaNotInDraft ? "idle" : "saved");
      publishNoteDraftChange({ key, origin: draftSyncOrigin });
      return !hasMediaNotInDraft;
    }
    if (result === "empty") {
      publishNoteDraftChange({ key, origin: draftSyncOrigin });
    }
    if (result === "unavailable" && isMeaningfulNoteDraft(draft)) {
      setDraftSaveStatus("unavailable");
      return false;
    }
    setDraftSaveStatus("idle");
    return !isDirty();
  };

  createEffect(() => {
    if (props.editingNoteId) {
      props.onDraftFlushAvailable?.(null);
    } else {
      props.onDraftFlushAvailable?.(saveCurrentDraftNow);
    }
  });

  createEffect(() => {
    unregisterDraftFlush?.();
    unregisterDraftFlush = undefined;
    const scope = draftScope();
    if (props.editingNoteId || props.draftActive === false || scope == null) {
      return;
    }
    unregisterDraftFlush = registerNoteDraftFlush(scope, saveCurrentDraftNow);
  });

  const restoreDraftMedia = (media: readonly NoteDraftMedia[]) => {
    draftRestoreMediaSubscription?.unsubscribe();
    draftRestoreMediaSubscription = undefined;
    if (media.length < 1) {
      setMediaItems([]);
      return;
    }
    setMediaItems(media.map((item) => ({
      localId: item.localId,
      previewUrl: item.url,
      alt: item.alt,
      mediumRelayId: item.mediumRelayId,
      uuid: item.uuid,
      url: item.url,
      width: item.width,
      height: item.height,
      uploading: false,
      uploadProgress: 100,
      generatingAlt: false,
    })));
    const storedById = new Map(media.map((item) => [item.mediumRelayId, item]));
    draftRestoreMediaSubscription = fetchQuery<NoteComposerDraftMediaQuery>(
      environment(),
      NoteComposerDraftMediaQuery,
      { ids: media.map((item) => item.mediumRelayId) },
    ).subscribe({
      next(data) {
        const restored = (data.nodes ?? []).flatMap((node) => {
          if (
            node == null || node.id == null || node.uuid == null ||
            node.url == null
          ) {
            return [];
          }
          const stored = storedById.get(node.id);
          if (stored == null) return [];
          return [
            {
              localId: stored.localId,
              previewUrl: node.url.toString(),
              alt: stored.alt,
              mediumRelayId: node.id,
              uuid: node.uuid,
              url: node.url.toString(),
              width: node.width ?? undefined,
              height: node.height ?? undefined,
              uploading: false,
              uploadProgress: 100,
              generatingAlt: false,
            } satisfies MediaItem,
          ];
        });
        if (restored.length < media.length) {
          showToast({
            title: t`Warning`,
            description:
              t`Some locally saved images are no longer available and were removed from the draft.`,
            variant: "warning",
          });
        }
        setMediaItems(restored);
      },
      error() {
        showToast({
          title: t`Warning`,
          description:
            t`Could not verify locally saved images. They may fail when you post.`,
          variant: "warning",
        });
      },
    });
  };

  const applyStoredDraft = (draft: StoredNoteDraft) => {
    restoringDraft = true;
    batch(() => {
      setContent(draft.content);
      setVisibility(draft.visibility);
      setQuotePolicy(draft.quotePolicy);
      setLanguage(draft.language ? new Intl.Locale(draft.language) : undefined);
      setManualLanguageChange(draft.language != null);
      setActingAccountKey(draft.actingAccountKey);
      if (draft.quotedPostId && !props.quotedPostId) {
        setPastedQuoteId(draft.quotedPostId);
      }
      setPollEnabled(canCreatePoll() && draft.poll.enabled);
      setPollTitle(draft.poll.title);
      setPollMultiple(draft.poll.multiple);
      setPollEnds(draft.poll.ends || defaultPollEnds());
      setPollOptions(
        draft.poll.options.length >= MIN_POLL_OPTIONS
          ? draft.poll.options.map((option) => ({
            localId: option.localId,
            title: option.title,
          }))
          : [
            { localId: createLocalId(), title: "" },
            { localId: createLocalId(), title: "" },
          ],
      );
      restoreDraftMedia(draft.media);
      setEditorResetKey((k) => k + 1);
    });
    queueMicrotask(() => {
      restoringDraft = false;
    });
  };

  const loadDraftFromStorage = (
    key: string,
    scope: NoteDraftScope,
    shouldPreserveCurrentForm: boolean,
  ) => {
    setDraftSaveStatus("idle");
    const draft = readNoteDraft(getBrowserDraftStorage(), key);
    if (draft != null) {
      if (!shouldPreserveCurrentForm) {
        applyStoredDraft(draft);
      }
      setHasLocalDraft(true);
    } else {
      if (!shouldPreserveCurrentForm) {
        resetFormForDraftScope(scope);
      }
      setHasLocalDraft(false);
    }
    formDraftKey = key;
    setLoadedDraftKey(key);
  };

  createEffect(() => {
    const key = draftStorageKey();
    const scope = draftScope();
    clearTimeout(saveDraftTimer);
    if (key == null || scope == null) {
      setDraftSaveStatus("idle");
      setLoadedDraftKey(null);
      formDraftKey = null;
      setHasLocalDraft(false);
      return;
    }
    const previousLoadedDraftKey = untrack(loadedDraftKey);
    const shouldPreserveCurrentForm = untrack(() =>
      previousLoadedDraftKey != null &&
      formDraftKey === previousLoadedDraftKey &&
      previousLoadedDraftKey !== key &&
      isDirty()
    );
    loadDraftFromStorage(key, scope, shouldPreserveCurrentForm);
  });

  onCleanup(subscribeNoteDraftChanges((change) => {
    if (change.origin === draftSyncOrigin) return;
    const key = untrack(draftStorageKey);
    const scope = untrack(draftScope);
    if (key == null || scope == null || change.key !== key) return;
    clearTimeout(saveDraftTimer);
    loadDraftFromStorage(key, scope, false);
  }));

  createEffect(() => {
    const key = draftStorageKey();
    const scope = draftScope();
    if (
      key == null || scope == null || loadedDraftKey() !== key ||
      restoringDraft
    ) {
      return;
    }
    void currentStorableDraftData();
    clearTimeout(saveDraftTimer);
    saveDraftTimer = setTimeout(() => {
      saveCurrentDraftNow();
    }, 350);
  });

  const clearCurrentDraft = () => {
    const key = draftStorageKey();
    if (key == null) return;
    removeNoteDraft(getBrowserDraftStorage(), key);
    setHasLocalDraft(false);
    setDraftSaveStatus("idle");
    publishNoteDraftChange({ key, origin: draftSyncOrigin });
  };

  const deleteCurrentDraftAndReset = () => {
    setShowDeleteDraftConfirm(false);
    clearCurrentDraft();
    resetForm();
  };

  // Use capture-phase listeners so Firefox's native textarea drag handling
  // cannot block our handlers.  relatedTarget in dragleave tells us whether
  // the drag is still inside the form, avoiding the need for a counter.
  onMount(() => {
    const form = formRef;
    if (!form) return;

    const hasFiles = (e: DragEvent) =>
      e.dataTransfer != null &&
      Array.from(e.dataTransfer.types).includes("Files");

    // Debounce dragleave instead of relying on relatedTarget, which browsers
    // set to null for OS-file drags even when the cursor is still inside the
    // form.  dragenter always fires before dragleave, so if the cursor moves
    // to a descendant the next dragenter cancels the timer before it fires.
    let dragLeaveTimer: ReturnType<typeof setTimeout> | undefined;

    const onDragEnter = (e: DragEvent) => {
      clearTimeout(dragLeaveTimer);
      dragLeaveTimer = undefined;
      if (hasFiles(e) && mediaItems.length < MAX_MEDIA) {
        setIsDraggingOver(true);
      }
    };

    const onDragOver = (e: DragEvent) => {
      if (hasFiles(e)) {
        e.preventDefault();
      }
    };

    const onDragLeave = () => {
      dragLeaveTimer = setTimeout(() => {
        dragLeaveTimer = undefined;
        setIsDraggingOver(false);
      }, 50);
    };

    const onDrop = (e: DragEvent) => {
      clearTimeout(dragLeaveTimer);
      dragLeaveTimer = undefined;
      setIsDraggingOver(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = e.dataTransfer!.files;
      if (files) addFiles(files);
    };

    const opts = { capture: true } as const;
    form.addEventListener("dragenter", onDragEnter, opts);
    form.addEventListener("dragover", onDragOver, opts);
    form.addEventListener("dragleave", onDragLeave, opts);
    form.addEventListener("drop", onDrop, opts);

    removeDragListeners = () => {
      clearTimeout(dragLeaveTimer);
      form.removeEventListener("dragenter", onDragEnter, opts);
      form.removeEventListener("dragover", onDragOver, opts);
      form.removeEventListener("dragleave", onDragLeave, opts);
      form.removeEventListener("drop", onDrop, opts);
    };
  });

  // Fetch quoted post preview when quotedPostId changes
  createEffect(() => {
    const id = effectiveQuotedPostId();
    if (!id) {
      setQuotedPost(null);
      setQuoteFetchError(false);
      return;
    }
    setQuotedPost(null);
    setQuoteFetchError(false);
    const subscription = fetchQuery<NoteComposerQuotedPostQuery>(
      environment(),
      NoteComposerQuotedPostQuery,
      { id },
    ).subscribe({
      next(data) {
        const node = data.node;
        if (
          !node ||
          (node.__typename !== "Note" &&
            node.__typename !== "Article" &&
            node.__typename !== "Question")
        ) {
          setQuotedPost(null);
          setQuoteFetchError(true);
          return;
        }
        if (!node.actor) {
          setQuotedPost(null);
          setQuoteFetchError(true);
          return;
        }
        setQuotedPost({
          typename: node.__typename,
          excerpt: node.excerpt,
          name: "name" in node ? (node.name ?? undefined) : undefined,
          actorName: node.actor.rawName ?? undefined,
          actorHandle: node.actor.handle,
          actorAvatarUrl: node.actor.avatarUrl,
        });
      },
      error() {
        setQuotedPost(null);
        setQuoteFetchError(true);
      },
    });
    onCleanup(() => subscription.unsubscribe());
  });

  // Fetch reply target preview and mention targets when replyTargetId changes
  createEffect(() => {
    const id = props.replyTargetId;
    if (!id) {
      setReplyTargetPost(null);
      setReplyTargetFetchError(false);
      // Keep a deliberate pre-fill (an edit body, or a "share this link" URL
      // via `initialContent`); only clear an auto-filled reply mention.
      if (!props.editingNoteId && !props.initialContent) {
        if (content() === prefillRef) setContent("");
        prefillRef = "";
        replyPrefillTargetId = null;
      }
      return;
    }
    setReplyTargetPost(null);
    setReplyTargetFetchError(false);
    const subscription = fetchQuery<NoteComposerReplyTargetQuery>(
      environment(),
      NoteComposerReplyTargetQuery,
      { id },
    ).subscribe({
      next(data) {
        const node = data.node;
        if (
          !node ||
          (node.__typename !== "Note" &&
            node.__typename !== "Article" &&
            node.__typename !== "Question")
        ) {
          setReplyTargetPost(null);
          setReplyTargetFetchError(true);
          return;
        }
        if (!node.actor) {
          setReplyTargetPost(null);
          setReplyTargetFetchError(true);
          return;
        }
        setReplyTargetPost({
          typename: node.__typename === "Article" ? "Article" : "Note",
          excerpt: node.excerpt,
          name: "name" in node ? (node.name ?? undefined) : undefined,
          actorName: node.actor.rawName ?? undefined,
          actorHandle: node.actor.handle,
          actorAvatarUrl: node.actor.avatarUrl,
        });

        // Compute mention targets following the same logic as the legacy web:
        // start with mentions on the target post, excluding the post's own
        // author (added separately below) and the current viewer.
        const viewerActorId = data.viewer?.actor?.id;
        const postActorId = node.actor.id;
        const mentionHandles = (node.mentions?.edges ?? [])
          .map((e) => e?.node)
          .filter(
            (a) =>
              a != null &&
              a.id !== postActorId &&
              a.id !== viewerActorId,
          )
          .map((a) => a!.handle);

        // Add the post's author at the front unless the viewer IS the author
        if (postActorId !== viewerActorId) {
          mentionHandles.unshift(node.actor.handle);
        }

        // Pre-fill content with the mention handles if the user hasn't typed
        // anything beyond the previous auto-fill (or the field is still empty)
        const newPrefill = mentionHandles.map((h) => `${h} `).join("");
        const oldPrefill = prefillRef;
        prefillRef = newPrefill;
        replyPrefillTargetId = id;
        if (content() === "" || content() === oldPrefill) {
          setContent(newPrefill);
        }
      },
      error() {
        setReplyTargetPost(null);
        setReplyTargetFetchError(true);
      },
    });
    onCleanup(() => subscription.unsubscribe());
  });

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

  const addFiles = (files: FileList | File[]) => {
    if (props.editingNoteId) return;
    const fileArray = Array.from(files).filter((f) =>
      SUPPORTED_IMAGE_TYPES.includes(f.type)
    );
    if (fileArray.length === 0) return;

    const current = mediaItems;
    const remaining = MAX_MEDIA - current.length;
    if (remaining <= 0) {
      showToast({
        title: t`Error`,
        description: t`You can attach up to ${MAX_MEDIA} images`,
        variant: "error",
      });
      return;
    }

    const toAdd = fileArray.slice(0, remaining);
    if (toAdd.length < fileArray.length) {
      showToast({
        title: t`Warning`,
        description:
          t`Some images were skipped because the limit of ${MAX_MEDIA} was reached`,
        variant: "warning",
      });
    }
    // Create handles before inserting items so abortUpload is set from the
    // start, avoiding a second setMediaItems pass for each file.
    const newItems: MediaItem[] = toAdd.map((file) => {
      const localId = createLocalId();
      const handle = uploadMediumFile(file, (progress) => {
        setMediaItems(produce((items) => {
          const m = items.find((m) => m.localId === localId);
          if (m) m.uploadProgress = progress;
        }));
      });
      handle.result.then((result) => {
        setMediaItems(produce((items) => {
          const m = items.find((m) => m.localId === localId);
          if (m) {
            m.uploading = false;
            m.uploadProgress = 100;
            m.uuid = result.uuid;
            m.mediumRelayId = result.mediumRelayId;
            m.url = result.url;
            m.width = result.width;
            m.height = result.height;
            m.abortUpload = undefined;
          }
        }));
      }).catch((err) => {
        if (err instanceof UploadAbortedError) return;
        setMediaItems(produce((items) => {
          const idx = items.findIndex((m) => m.localId === localId);
          if (idx !== -1) {
            revokePreviewUrl(items[idx].previewUrl);
            items.splice(idx, 1);
          }
        }));
        showToast({
          title: t`Error`,
          description: err instanceof Error && err.message
            ? err.message
            : t`Failed to upload image`,
          variant: "error",
        });
      });
      return {
        localId,
        file,
        previewUrl: URL.createObjectURL(file),
        alt: "",
        uploading: true,
        uploadProgress: 0,
        generatingAlt: false,
        abortUpload: handle.abort,
      };
    });

    setMediaItems(produce((items) => {
      items.push(...newItems);
    }));
  };

  const handlePaste = (e: ClipboardEvent) => {
    // Check for pasted images first
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      const imageFiles = Array.from(files).filter((f) =>
        SUPPORTED_IMAGE_TYPES.includes(f.type)
      );
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
        return;
      }
    }

    // Fall through to URL-paste-to-quote logic
    if (props.editingNoteId || effectiveQuotedPostId()) return;
    const clipboardText = e.clipboardData?.getData("text/plain");
    if (clipboardText == null) return;
    const text = clipboardText.trim();
    if (!text || !URL.canParse(text) || !text.match(/^https?:/)) return;
    const target = e.currentTarget;
    if (!(target instanceof HTMLTextAreaElement)) return;
    e.preventDefault();
    const pasteStart = target.selectionStart;
    const pasteEnd = target.selectionEnd;
    const pastedRange = {
      start: pasteStart,
      end: pasteStart + clipboardText.length,
    };
    setContent((prev) =>
      prev.slice(0, pasteStart) + clipboardText + prev.slice(pasteEnd)
    );
    queueMicrotask(() => {
      target.setSelectionRange(pastedRange.end, pastedRange.end);
    });
    const removePastedUrl = () => {
      setContent((prev) => {
        if (
          prev.slice(pastedRange.start, pastedRange.end) === clipboardText
        ) {
          return prev.slice(0, pastedRange.start) +
            prev.slice(pastedRange.end);
        }
        const firstMatch = prev.indexOf(clipboardText);
        if (firstMatch >= 0 && firstMatch === prev.lastIndexOf(clipboardText)) {
          return prev.slice(0, firstMatch) +
            prev.slice(firstMatch + clipboardText.length);
        }
        return prev;
      });
    };
    fetchQuery<NoteComposerPostByUrlQuery>(
      environment(),
      NoteComposerPostByUrlQuery,
      {
        url: text,
        actingAccountId: actingAccountInput().actingAccountId ?? null,
      },
    ).subscribe({
      next(data) {
        const post = data.postByUrl;
        if (!post) {
          return;
        }
        if (
          post.__typename !== "Note" && post.__typename !== "Article" &&
          post.__typename !== "Question"
        ) {
          return;
        }
        if (!post.viewerCanQuote) {
          return;
        }
        if (!confirm(t`Do you want to quote this link?`)) {
          return;
        }
        removePastedUrl();
        setPastedQuoteId(post.id);
      },
      error() {},
    });
  };

  const handleLanguageChange = (locale?: Intl.Locale) => {
    setLanguage(locale);
    setManualLanguageChange(true);
  };

  const clearPastedQuote = () => {
    setPastedQuoteId(null);
    setQuotedPost(null);
    setQuoteFetchError(false);
  };

  const resetPoll = () => {
    setPollEnabled(false);
    setPollTitle("");
    setPollMultiple(false);
    setPollEnds(defaultPollEnds());
    setPollOptions([
      { localId: createLocalId(), title: "" },
      { localId: createLocalId(), title: "" },
    ]);
  };

  createEffect(() => {
    if (props.editingNoteId) resetPoll();
  });

  const setPollDuration = (days: number) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setSeconds(0, 0);
    setPollEnds(formatDateTimeLocal(date));
  };

  const getValidatedPollInput = (): ValidatedPollInput | null => {
    const title = pollTitle().trim();
    if (!title) {
      showToast({
        title: t`Error`,
        description: t`Poll title cannot be empty`,
        variant: "error",
      });
      return null;
    }

    const options = pollOptions.map((option) => option.title.trim());
    if (options.some((option) => option === "")) {
      showToast({
        title: t`Error`,
        description: t`Poll options cannot be empty`,
        variant: "error",
      });
      return null;
    }
    if (options.length < MIN_POLL_OPTIONS) {
      showToast({
        title: t`Error`,
        description: t`Add at least ${MIN_POLL_OPTIONS} poll options`,
        variant: "error",
      });
      return null;
    }
    if (new Set(options).size !== options.length) {
      showToast({
        title: t`Error`,
        description: t`Poll options must be unique`,
        variant: "error",
      });
      return null;
    }

    const ends = parseDateTimeLocal(pollEnds());
    if (!Number.isFinite(ends.getTime())) {
      showToast({
        title: t`Error`,
        description: t`Poll deadline is invalid`,
        variant: "error",
      });
      return null;
    }
    if (ends.getTime() - Date.now() < 60_000) {
      showToast({
        title: t`Error`,
        description: t`Poll deadline must be at least 1 minute from now`,
        variant: "error",
      });
      return null;
    }

    return {
      title,
      multiple: pollMultiple(),
      options,
      ends: ends.toISOString(),
    };
  };

  function resetForm() {
    formDraftKey = null;
    draftRestoreMediaSubscription?.unsubscribe();
    draftRestoreMediaSubscription = undefined;
    for (const item of mediaItems) {
      item.abortUpload?.();
      item.altSubscription?.unsubscribe();
      revokePreviewUrl(item.previewUrl);
    }
    prefillRef = "";
    replyPrefillTargetId = null;
    setContent("");
    setVisibility(props.defaultVisibility ?? "PUBLIC");
    setQuotePolicy("EVERYONE");
    setLanguage(new Intl.Locale(i18n.locale));
    setManualLanguageChange(false);
    setActingAccountKey(actingAccount.defaultComposeAccountKey());
    setQuotedPost(null);
    setPastedQuoteId(null);
    setQuoteFetchError(false);
    setReplyTargetPost(null);
    setReplyTargetFetchError(false);
    setMediaItems([]);
    resetPoll();
    setEditorResetKey((k) => k + 1);
  }

  function resetFormForDraftScope(scope: NoteDraftScope) {
    const currentContent = untrack(content);
    const currentPrefill = prefillRef;
    const currentReplyPrefillTargetId = replyPrefillTargetId;
    resetForm();
    if (scope.type === "prefill") {
      const initialContent = props.initialContent ?? "";
      prefillRef = initialContent;
      setContent(initialContent);
      setEditorResetKey((k) => k + 1);
    } else if (
      scope.type === "reply" &&
      currentPrefill !== "" &&
      currentContent === currentPrefill &&
      currentReplyPrefillTargetId === scope.targetId
    ) {
      prefillRef = currentPrefill;
      replyPrefillTargetId = currentReplyPrefillTargetId;
      setContent(currentPrefill);
      setEditorResetKey((k) => k + 1);
    }
  }

  const handleSubmit = (e: Event) => {
    e.preventDefault();

    const noteContent = content().trim();
    if (!noteContent) {
      showToast({
        title: t`Error`,
        description: t`Content cannot be empty`,
        variant: "error",
      });
      return;
    }

    const items = mediaItems;
    if (items.some((m) => m.uploading)) {
      showToast({
        title: t`Error`,
        description: t`All images must finish uploading before posting`,
        variant: "error",
      });
      return;
    }
    if (items.some((m) => !m.alt.trim())) {
      showToast({
        title: t`Error`,
        description: t`All images require alt text`,
        variant: "error",
      });
      return;
    }

    if (props.editingNoteId) {
      const isPublicOrUnlisted = props.editingVisibility === "PUBLIC" ||
        props.editingVisibility === "UNLISTED";
      updateNote({
        variables: {
          input: {
            noteId: props.editingNoteId,
            content: noteContent,
            language: language()?.baseName ?? null,
            quotePolicy: isPublicOrUnlisted
              ? effectiveQuotePolicy()
              : undefined,
            ...editActingAccountInput(),
          },
        },
        onCompleted(response) {
          if (response.updateNote.__typename === "UpdateNotePayload") {
            showToast({
              title: t`Success`,
              description: t`Note updated`,
              variant: "success",
            });
            clearCurrentDraft();
            resetForm();
            props.onSuccess?.();
          } else if (
            response.updateNote.__typename === "InvalidInputError"
          ) {
            showToast({
              title: t`Error`,
              description: t`Invalid input: ${response.updateNote.inputPath}`,
              variant: "error",
            });
          } else if (
            response.updateNote.__typename === "NotAuthenticatedError"
          ) {
            showToast({
              title: t`Error`,
              description: t`You must be signed in to edit a note`,
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
    } else {
      // Append the discussed link to the bottom unless the author already
      // included it, so an inline opinion joins this link's discussion.
      const finalContent = props.ensureLinkUrl
        ? ensureLinkInContent(noteContent, props.ensureLinkUrl)
        : noteContent;
      if (canCreatePoll() && pollEnabled()) {
        const poll = getValidatedPollInput();
        if (poll == null) return;
        createQuestion({
          variables: {
            input: {
              content: finalContent,
              language: language()?.baseName ?? i18n.locale,
              visibility: visibility(),
              quotePolicy: effectiveQuotePolicy(),
              quotedPostId: effectiveQuotedPostId() ?? null,
              replyTargetId: props.replyTargetId ?? null,
              ...actingAccountInput(),
              poll,
              media: items.map((m) => ({
                mediumId: m
                  .uuid! as `${string}-${string}-${string}-${string}-${string}`,
                alt: m.alt.trim(),
              })),
            },
            connections: props.prependToConnections ?? [],
            actingAccountId: actingAccountInput().actingAccountId ?? null,
            includeDiscussionThreadFields:
              (props.prependToConnections?.length ?? 0) > 0,
          },
          onCompleted(response) {
            if (
              response.createQuestion.__typename === "CreateQuestionPayload"
            ) {
              showToast({
                title: t`Success`,
                description: t`Poll created successfully`,
                variant: "success",
              });
              clearCurrentDraft();
              resetForm();
              props.onSuccess?.();
            } else if (
              response.createQuestion.__typename === "InvalidInputError"
            ) {
              showToast({
                title: t`Error`,
                description:
                  t`Invalid input: ${response.createQuestion.inputPath}`,
                variant: "error",
              });
            } else if (
              response.createQuestion.__typename === "NotAuthenticatedError"
            ) {
              showToast({
                title: t`Error`,
                description: t`You must be signed in to create a poll`,
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
        return;
      }
      createNote({
        variables: {
          input: {
            content: finalContent,
            language: language()?.baseName ?? i18n.locale,
            visibility: visibility(),
            quotePolicy: effectiveQuotePolicy(),
            quotedPostId: effectiveQuotedPostId() ?? null,
            replyTargetId: props.replyTargetId ?? null,
            ...actingAccountInput(),
            media: items.map((m) => ({
              mediumId: m
                .uuid! as `${string}-${string}-${string}-${string}-${string}`,
              alt: m.alt.trim(),
            })),
          },
          connections: props.prependToConnections ?? [],
          actingAccountId: actingAccountInput().actingAccountId ?? null,
          includeDiscussionThreadFields:
            (props.prependToConnections?.length ?? 0) > 0,
        },
        onCompleted(response) {
          if (response.createNote.__typename === "CreateNotePayload") {
            const href = getNoteInternalHref(response.createNote.note);
            showToast({
              title: t`Success`,
              description: t`Note created successfully`,
              href,
              variant: "success",
            });
            clearCurrentDraft();
            resetForm();
            props.onSuccess?.();
          } else if (response.createNote.__typename === "InvalidInputError") {
            showToast({
              title: t`Error`,
              description: t`Invalid input: ${response.createNote.inputPath}`,
              variant: "error",
            });
          } else if (
            response.createNote.__typename === "NotAuthenticatedError"
          ) {
            showToast({
              title: t`Error`,
              description: t`You must be signed in to create a note`,
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
    }
  };

  const handleGenerateAlt = (localId: string) => {
    const item = mediaItems.find((m) => m.localId === localId);
    if (!item?.mediumRelayId) return;

    setMediaItems(produce((items) => {
      const m = items.find((m) => m.localId === localId);
      if (m) m.generatingAlt = true;
    }));

    const subscription = fetchQuery<NoteComposerGeneratedAltTextQuery>(
      environment(),
      NoteComposerGeneratedAltTextQuery,
      {
        mediumId: item.mediumRelayId,
        language: language()?.baseName ?? i18n.locale,
        context: content().trim() || undefined,
      },
    ).subscribe({
      next(data) {
        const medium = data.node;
        if (medium && "generatedAltText" in medium) {
          setMediaItems(produce((items) => {
            const m = items.find((m) => m.localId === localId);
            if (m) {
              m.generatingAlt = false;
              m.alt = medium.generatedAltText ?? m.alt;
              m.altSubscription = undefined;
            }
          }));
        } else {
          setMediaItems(produce((items) => {
            const m = items.find((m) => m.localId === localId);
            if (m) {
              m.generatingAlt = false;
              m.altSubscription = undefined;
            }
          }));
        }
      },
      error(err: Error) {
        setMediaItems(produce((items) => {
          const m = items.find((m) => m.localId === localId);
          if (m) {
            m.generatingAlt = false;
            m.altSubscription = undefined;
          }
        }));
        showToast({
          title: t`Error`,
          description: err?.message || t`Failed to generate alt text`,
          variant: "error",
        });
      },
    });
    setMediaItems(produce((items) => {
      const m = items.find((m) => m.localId === localId);
      if (m) m.altSubscription = subscription;
    }));
  };

  const handleCancelAlt = (localId: string) => {
    setMediaItems(produce((items) => {
      const m = items.find((m) => m.localId === localId);
      if (m) {
        m.altSubscription?.unsubscribe();
        m.altSubscription = undefined;
        m.generatingAlt = false;
      }
    }));
  };

  return (
    <>
      <form
        ref={(el) => (formRef = el)}
        onSubmit={handleSubmit}
        class={props.class}
      >
        <div
          class={`grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 rounded-lg transition-colors ${
            isDraggingOver()
              ? "outline outline-2 outline-dashed outline-primary"
              : ""
          }`}
        >
          {
            /* Suspended accounts cannot create posts (editing an existing one
            stays allowed); the write itself is blocked server-side, but
            surface it here instead of a generic failure. */
          }
          <Show when={!props.editingNoteId && viewer.suspended()}>
            <div class="rounded-md border border-warning-foreground bg-warning px-3 py-2 text-sm text-warning-foreground">
              {t`Your account is suspended, so you can't post right now. See your sanctions for details and how to appeal.`}
            </div>
          </Show>
          {/* Reply target preview — hidden in edit mode */}
          <Show
            when={!props.editingNoteId && props.replyTargetId &&
              props.showReplyTarget !== false}
          >
            <div class="rounded-md border border-input bg-muted/50 p-3">
              <p class="text-xs text-muted-foreground mb-2">{t`Replying to`}</p>
              <Show
                keyed
                when={replyTargetPost()}
                fallback={
                  <span class="text-sm text-muted-foreground">
                    {replyTargetFetchError()
                      ? t`Failed to load post`
                      : t`Loading…`}
                  </span>
                }
              >
                {(rtp) => (
                  <div class="flex items-start gap-3">
                    <Avatar class="size-8 flex-shrink-0">
                      <AvatarImage src={rtp.actorAvatarUrl} />
                      <AvatarFallback class="size-8">
                        {rtp.actorName?.charAt(0) ?? "?"}
                      </AvatarFallback>
                    </Avatar>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1 text-sm">
                        <span class="font-medium truncate">
                          {rtp.actorName ?? rtp.actorHandle}
                        </span>
                        <Show when={rtp.actorName}>
                          <span class="text-muted-foreground truncate">
                            {rtp.actorHandle}
                          </span>
                        </Show>
                      </div>
                      <Show when={rtp.typename === "Article" && rtp.name}>
                        <div class="text-sm font-medium mt-1">{rtp.name}</div>
                      </Show>
                      <Show keyed when={rtp.excerpt}>
                        {(excerpt) => (
                          <p class="text-sm text-muted-foreground mt-1 line-clamp-3">
                            {excerpt}
                          </p>
                        )}
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            </div>
          </Show>

          {/* Quoted post preview — hidden in edit mode */}
          <Show when={!props.editingNoteId && effectiveQuotedPostId()}>
            <div class="flex items-start gap-3 rounded-md border border-input bg-muted/50 p-3">
              <Show
                keyed
                when={quotedPost()}
                fallback={
                  <div class="flex-1 min-w-0">
                    <span class="text-sm text-muted-foreground">
                      {quoteFetchError()
                        ? t`Failed to load quoted post`
                        : t`Loading quoted post…`}
                    </span>
                  </div>
                }
              >
                {(qp) => (
                  <>
                    <Avatar class="size-8 flex-shrink-0">
                      <AvatarImage src={qp.actorAvatarUrl} />
                      <AvatarFallback class="size-8">
                        {qp.actorName?.charAt(0) ?? "?"}
                      </AvatarFallback>
                    </Avatar>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1 text-sm">
                        <span class="font-medium truncate">
                          {qp.actorName ?? qp.actorHandle}
                        </span>
                        <Show when={qp.actorName}>
                          <span class="text-muted-foreground truncate">
                            {qp.actorHandle}
                          </span>
                        </Show>
                      </div>
                      <Show when={qp.typename === "Article" && qp.name}>
                        <div class="text-sm font-medium mt-1">{qp.name}</div>
                      </Show>
                      <Show keyed when={qp.excerpt}>
                        {(excerpt) => (
                          <p class="text-sm text-muted-foreground mt-1 line-clamp-3">
                            {excerpt}
                          </p>
                        )}
                      </Show>
                    </div>
                  </>
                )}
              </Show>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="h-6 w-6 p-0 text-muted-foreground hover:text-foreground flex-shrink-0"
                onClick={() => {
                  props.onQuoteRemoved?.();
                  clearPastedQuote();
                }}
                title={t`Remove quote`}
                aria-label={t`Remove quote`}
              >
                <IconX class="size-4" />
              </Button>
            </div>
          </Show>

          <Show
            when={!props.editingNoteId &&
              composeActingAccountOptions().length > 1}
          >
            <ActingAccountSelect
              value={actingAccountKey()}
              onChange={setActingAccountKey}
            />
          </Show>

          <TextField value={content()} onChange={setContent}>
            <TextFieldLabel class="sr-only">{t`Content`}</TextFieldLabel>
            <MarkdownEditor
              value={content()}
              onInput={setContent}
              resetKey={editorResetKey()}
              ref={(el) => (textareaRef = el)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  const submitting = isSubmitting() ||
                    (!props.editingNoteId && viewer.suspended()) ||
                    mediaItems.some((m) => m.uploading) ||
                    (!!effectiveQuotedPostId() && !quotedPost() &&
                      !quoteFetchError()) ||
                    (!!props.replyTargetId &&
                      props.showReplyTarget !== false &&
                      !replyTargetPost() && !replyTargetFetchError());
                  if (!submitting) formRef?.requestSubmit();
                }
              }}
              onWheel={(e) => {
                const el = e.currentTarget;
                const scrollingDown = e.deltaY > 0;
                if (
                  (scrollingDown &&
                    el.scrollTop + el.clientHeight < el.scrollHeight) ||
                  (!scrollingDown && el.scrollTop > 0)
                ) {
                  e.stopPropagation();
                }
              }}
              placeholder={props.placeholder ?? t`What's on your mind?`}
              autofocus={props.autoFocus}
              minHeight="min-h-[150px]"
              writeTabSlot={
                <MentionAutocomplete
                  textareaRef={() => textareaRef}
                  onComplete={() => {
                    if (textareaRef) setContent(textareaRef.value);
                  }}
                />
              }
            />
            <div class="flex items-center justify-between mt-1">
              {/* Media attach button — hidden in edit mode */}
              <Show when={!props.editingNoteId} fallback={<span />}>
                <div class="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={mediaItems.length >= MAX_MEDIA}
                    title={t`Attach image`}
                    aria-label={t`Attach image`}
                    onClick={() => fileInputRef?.click()}
                  >
                    <IconImage class="size-5" />
                  </Button>
                  <Show when={allowPoll()}>
                    <Button
                      type="button"
                      variant={pollEnabled() ? "secondary" : "ghost"}
                      size="icon"
                      title={pollEnabled() ? t`Remove poll` : t`Add poll`}
                      aria-label={pollEnabled() ? t`Remove poll` : t`Add poll`}
                      onClick={() => {
                        if (pollEnabled()) resetPoll();
                        else setPollEnabled(true);
                      }}
                    >
                      <IconListChecks class="size-5" />
                    </Button>
                  </Show>
                </div>
              </Show>
              <input
                ref={(el) => (fileInputRef = el)}
                type="file"
                accept={SUPPORTED_IMAGE_TYPES.join(",")}
                multiple
                class="hidden"
                onChange={(e) => {
                  const files = e.currentTarget.files;
                  if (files) addFiles(files);
                  e.currentTarget.value = "";
                }}
              />
              <a
                href="/markdown"
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
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
            </div>
          </TextField>

          <Show when={canCreatePoll() && pollEnabled()}>
            <section class="rounded-md border border-input p-3">
              <div class="flex items-start justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2">
                  <IconListChecks class="size-4 shrink-0 text-muted-foreground" />
                  <h3 class="text-sm font-medium">{t`Poll`}</h3>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="size-7 shrink-0"
                  title={t`Remove poll`}
                  aria-label={t`Remove poll`}
                  onClick={resetPoll}
                >
                  <IconX class="size-4" />
                </Button>
              </div>

              <div class="mt-3 grid gap-3">
                <label class="grid gap-1.5">
                  <span class="text-xs font-medium text-muted-foreground">
                    {t`Poll title`}
                  </span>
                  <input
                    type="text"
                    value={pollTitle()}
                    maxLength={200}
                    onInput={(e) => setPollTitle(e.currentTarget.value)}
                    placeholder={t`What should people decide?`}
                    class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>

                <div class="grid gap-1.5">
                  <span class="text-xs font-medium text-muted-foreground">
                    {t`Selection`}
                  </span>
                  <div class="grid grid-cols-2 overflow-hidden rounded-md border border-input">
                    <Button
                      type="button"
                      variant={pollMultiple() ? "ghost" : "secondary"}
                      class="h-9 rounded-none border-r"
                      onClick={() => setPollMultiple(false)}
                    >
                      {t`Single choice`}
                    </Button>
                    <Button
                      type="button"
                      variant={pollMultiple() ? "secondary" : "ghost"}
                      class="h-9 rounded-none"
                      onClick={() => setPollMultiple(true)}
                    >
                      {t`Multiple choice`}
                    </Button>
                  </div>
                </div>

                <div class="grid gap-2">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs font-medium text-muted-foreground">
                      {t`Options`}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pollOptions.length >= MAX_POLL_OPTIONS}
                      onClick={() =>
                        setPollOptions(produce((options) => {
                          if (options.length >= MAX_POLL_OPTIONS) return;
                          options.push({
                            localId: createLocalId(),
                            title: "",
                          });
                        }))}
                    >
                      <IconPlus class="mr-1 size-3.5" />
                      {t`Add option`}
                    </Button>
                  </div>
                  <For each={pollOptions}>
                    {(option, index) => (
                      <div class="grid grid-cols-[1fr_auto] gap-2">
                        <input
                          type="text"
                          value={option.title}
                          maxLength={200}
                          onInput={(e) =>
                            setPollOptions(
                              index(),
                              "title",
                              e.currentTarget.value,
                            )}
                          placeholder={t`Option ${index() + 1}`}
                          class="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          class="size-9 text-muted-foreground hover:text-foreground"
                          disabled={pollOptions.length <= MIN_POLL_OPTIONS}
                          title={t`Remove option`}
                          aria-label={t`Remove option`}
                          onClick={() =>
                            setPollOptions(produce((options) => {
                              if (options.length <= MIN_POLL_OPTIONS) return;
                              options.splice(index(), 1);
                            }))}
                        >
                          <IconTrash class="size-4" />
                        </Button>
                      </div>
                    )}
                  </For>
                </div>

                <div class="grid gap-1.5">
                  <span class="text-xs font-medium text-muted-foreground">
                    {t`Deadline`}
                  </span>
                  <div class="flex flex-wrap gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPollDuration(1)}
                    >
                      {t`1 day`}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPollDuration(3)}
                    >
                      {t`3 days`}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setPollDuration(7)}
                    >
                      {t`1 week`}
                    </Button>
                  </div>
                  <input
                    type="datetime-local"
                    value={pollEnds()}
                    onInput={(e) => setPollEnds(e.currentTarget.value)}
                    class="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>

                <p class="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
                  {t`Polls cannot be edited after publishing.`}
                </p>
              </div>
            </section>
          </Show>

          {/* Toolbar: language, visibility, quote policy */}
          <div class="flex flex-wrap items-center gap-2">
            <LanguageSelect
              value={language()}
              onChange={handleLanguageChange}
              class="flex-1 min-w-[8rem]"
            />
            <NoteVisibilityQuotePolicySelect
              visibility={props.editingNoteId
                ? (props.editingVisibility ?? "PUBLIC")
                : visibility()}
              quotePolicy={quotePolicy()}
              onVisibilityChange={props.editingNoteId
                ? undefined
                : setVisibility}
              onQuotePolicyChange={setQuotePolicy}
              visibilityDisabled={!!props.editingNoteId}
            />
          </div>

          {/* Media previews — hidden in edit mode */}
          <Show when={!props.editingNoteId && mediaItems.length > 0}>
            <div class="flex flex-col gap-3">
              <For each={mediaItems}>
                {(item, index) => (
                  <div class="flex gap-3 items-start">
                    {/* Thumbnail with progress overlay */}
                    <div class="relative flex-shrink-0 w-20 h-20 rounded-md overflow-hidden bg-muted">
                      <img
                        src={item.previewUrl}
                        alt=""
                        class="w-full h-full object-cover"
                      />
                      <Show when={item.uploading}>
                        <div class="absolute inset-0 flex flex-col items-center justify-center bg-background/70 gap-1 px-2">
                          <progress
                            value={item.uploadProgress}
                            max={100}
                            class="w-full h-1.5 rounded-full"
                            aria-label={t`Upload progress`}
                          />
                          <span class="text-xs text-muted-foreground">
                            {item.uploadProgress}%
                          </span>
                        </div>
                      </Show>
                    </div>

                    {/* Alt text input + controls */}
                    <div class="flex-1 flex flex-col gap-1.5">
                      <textarea
                        value={item.alt}
                        aria-label={t`Alt text for image ${index() + 1}`}
                        aria-required="true"
                        required
                        onInput={(e) => {
                          const v = e.currentTarget.value;
                          setMediaItems(produce((items) => {
                            const m = items.find((m) =>
                              m.localId === item.localId
                            );
                            if (m) m.alt = v;
                          }));
                        }}
                        placeholder={t`Alt text for visually impaired people (required)`}
                        disabled={item.generatingAlt}
                        rows={3}
                        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      />
                      <div class="flex gap-1 justify-end">
                        <Show when={item.mediumRelayId && !item.uploading}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={item.generatingAlt}
                            aria-label={t`Auto-fill alt text`}
                            title={t`Auto-fill alt text`}
                            onClick={() => handleGenerateAlt(item.localId)}
                          >
                            <Show
                              when={item.generatingAlt}
                              fallback={
                                <span class="text-xs">{t`Auto-fill`}</span>
                              }
                            >
                              {/* Spinner */}
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke-width="1.5"
                                stroke="currentColor"
                                class="size-4 animate-spin"
                                aria-hidden="true"
                              >
                                <path
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
                                />
                              </svg>
                              <span class="text-xs ml-1">{t`Generating…`}</span>
                            </Show>
                          </Button>
                        </Show>
                        <Show when={item.generatingAlt}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={t`Cancel`}
                            title={t`Cancel`}
                            onClick={() => handleCancelAlt(item.localId)}
                          >
                            <IconSquare class="size-4" />
                          </Button>
                        </Show>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          class="text-muted-foreground hover:text-foreground"
                          aria-label={t`Remove image`}
                          title={t`Remove image`}
                          onClick={() => {
                            item.abortUpload?.();
                            item.altSubscription?.unsubscribe();
                            revokePreviewUrl(item.previewUrl);
                            setMediaItems(produce((items) => {
                              const idx = items.findIndex(
                                (m) => m.localId === item.localId,
                              );
                              if (idx !== -1) items.splice(idx, 1);
                            }));
                          }}
                        >
                          <IconX class="size-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show
            when={!props.editingNoteId &&
              (currentDraftIsMeaningful() || hasLocalDraft() ||
                draftSaveStatus() === "unavailable")}
          >
            <div class="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
              <span>
                <Show
                  when={draftSaveStatus() !== "unavailable"}
                  fallback={t`Local draft could not be saved`}
                >
                  {hasLocalDraft() ? t`Saved locally` : t`Local draft`}
                </Show>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => setShowDeleteDraftConfirm(true)}
              >
                {t`Delete local draft`}
              </Button>
            </div>
          </Show>

          <Show when={showArticleSwitchButton() && canSwitchToArticle()}>
            <div class="flex justify-end border-t pt-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={switchToArticleDraft}
                disabled={isSubmitting()}
              >
                <IconFileText class="size-4" />
                {isSavingArticleDraft() ? t`Saving…` : t`Switch to article`}
              </Button>
            </div>
          </Show>

          <div class="flex min-w-0 gap-2 justify-end">
            <Show when={props.showCancelButton}>
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onCancel?.()}
                disabled={isSubmitting()}
              >
                {t`Cancel`}
              </Button>
            </Show>
            <Button
              type="submit"
              disabled={isSubmitting() ||
                (props.editingNoteId ? !isDirty() : (
                  viewer.suspended() ||
                  mediaItems.some((m) => m.uploading) ||
                  (!!effectiveQuotedPostId() && !quotedPost() &&
                    !quoteFetchError()) ||
                  (!!props.replyTargetId && props.showReplyTarget !== false &&
                    !replyTargetPost() && !replyTargetFetchError())
                ))}
            >
              <Show
                when={props.editingNoteId}
                fallback={
                  <Show
                    when={isCreating() || isCreatingQuestion()}
                    fallback={canCreatePoll() && pollEnabled()
                      ? t`Create poll`
                      : t`Create note`}
                  >
                    {t`Creating…`}
                  </Show>
                }
              >
                <Show when={isUpdating()} fallback={t`Save changes`}>
                  {t`Saving…`}
                </Show>
              </Show>
            </Button>
          </div>
        </div>
      </form>

      <AlertDialog
        open={showDeleteDraftConfirm()}
        onOpenChange={(open) => !open && setShowDeleteDraftConfirm(false)}
      >
        <AlertDialogContent class="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Delete local draft?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`This clears the saved draft from this browser.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>{t`Keep draft`}</AlertDialogClose>
            <AlertDialogAction
              class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={deleteCurrentDraftAndReset}
            >
              {t`Delete draft`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showArticleSuggestion()}
        onOpenChange={(open) => {
          if (!open && showArticleSuggestion()) dismissArticleSuggestion();
        }}
      >
        <AlertDialogContent class="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Write this as an article?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`This note is getting long. Articles give longer writing a title, a dedicated draft, and a better reading page.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose onClick={dismissArticleSuggestion}>
              {t`Keep writing note`}
            </AlertDialogClose>
            <AlertDialogAction
              onClick={switchToArticleDraft}
              disabled={isSavingArticleDraft()}
            >
              {isSavingArticleDraft() ? t`Saving…` : t`Save as article draft`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function getNoteInternalHref(
  note: NonNullable<
    NoteComposerMutation["response"]["createNote"] & {
      __typename: "CreateNotePayload";
    }
  >["note"],
): string {
  const actorSegment = note.actor.local
    ? `@${note.actor.username}`
    : encodeHandleSegment(note.actor.handle);
  return `/${actorSegment}/${note.sourceId ?? note.uuid}`;
}
