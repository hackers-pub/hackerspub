import { useNavigate } from "@solidjs/router";
import { fetchQuery, graphql } from "relay-runtime";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { useRelayEnvironment } from "solid-relay";
import IconFileText from "~icons/lucide/file-text";
import IconImage from "~icons/lucide/image";
import IconListChecks from "~icons/lucide/list-checks";
import IconX from "~icons/lucide/x";
import { shouldSuggestArticleForNote } from "~/lib/formatGuidance.ts";
import { detectLanguage } from "~/lib/langdet.ts";
import {
  type NoteDraftData,
  type NoteDraftScope,
  type StoredNoteDraft,
} from "~/lib/noteDraftStorage.ts";
import {
  isSupportedImageFile,
  supportedImageAccept,
} from "~/lib/supportedImageFile.ts";
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
import { createDraftController } from "./note-composer/createDraftController.ts";
import {
  createMediaController,
  MAX_MEDIA,
} from "./note-composer/createMediaController.ts";
import { createPollController } from "./note-composer/createPollController.ts";
import { createSubmissionController } from "./note-composer/createSubmissionController.ts";
import {
  createNoteDraftData,
  getNoteComposerDraftScope,
  hasUnstorableDraftMedia,
  toStorableNoteDraftData,
} from "./note-composer/draftState.ts";
import { MediaEditor } from "./note-composer/MediaEditor.tsx";
import { PollEditor } from "./note-composer/PollEditor.tsx";
import { MIN_POLL_OPTIONS } from "./note-composer/pollState.ts";
import type { NoteComposerPostByUrlQuery } from "./__generated__/NoteComposerPostByUrlQuery.graphql.ts";
import type { NoteComposerQuotedPostQuery } from "./__generated__/NoteComposerQuotedPostQuery.graphql.ts";
import type { NoteComposerReplyTargetQuery } from "./__generated__/NoteComposerReplyTargetQuery.graphql.ts";

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

interface QuotedPostPreview {
  typename: "Note" | "Article" | "Question";
  excerpt: string;
  name?: string;
  actorName?: string;
  actorHandle: string;
  actorAvatarUrl: string;
}

export type NoteDraftFlush = () => boolean;

export interface NoteComposerProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  onContentChange?: (dirty: boolean) => void;
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
  // New notes only: Relay connection record ids to append the created note's
  // edge into, for chronological reply trees such as article comments.
  appendToConnections?: string[];
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

  const media = createMediaController({
    environment,
    editing: () => !!props.editingNoteId,
    language: () => language()?.baseName ?? i18n.locale,
    content,
  });
  const mediaItems = media.items;
  const poll = createPollController();
  const [isDraggingOver, setIsDraggingOver] = createSignal(false);
  const [editorResetKey, setEditorResetKey] = createSignal(0);
  let formRef: HTMLFormElement | undefined;
  let removeDragListeners: (() => void) | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;

  const draftScope = createMemo<NoteDraftScope | null>(() =>
    getNoteComposerDraftScope(props)
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
    removeDragListeners?.();
  });

  // In edit mode treat any divergence from the original as dirty, including
  // clearing all content.  In compose mode keep the original guard so an
  // empty textarea isn't flagged dirty on first render.
  const dirty = createMemo(() => {
    const contentDirty = props.editingNoteId
      ? content().trim() !== prefillRef.trim()
      : content().trim() !== "" && content().trim() !== prefillRef.trim();
    const editMetaDirty = !!props.editingNoteId && (
      language()?.baseName !== (props.initialLanguage ?? undefined) ||
      quotePolicy() !== (props.initialQuotePolicy ?? "EVERYONE")
    );
    const pollDirty = canCreatePoll() && poll.enabled();
    return contentDirty || mediaItems().length > 0 || editMetaDirty ||
      pollDirty;
  });
  createEffect(() => props.onContentChange?.(dirty()));
  const isPlainNewNote = () =>
    !props.editingNoteId &&
    !props.replyTargetId &&
    !props.quotedPostId &&
    !props.ensureLinkUrl &&
    !props.initialContent &&
    effectiveQuotedPostId() == null;
  const canSwitchToArticle = () =>
    isPlainNewNote() &&
    mediaItems().length === 0 &&
    !poll.enabled() &&
    content().trim() !== "";

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

  const currentDraftData = (): NoteDraftData =>
    createNoteDraftData({
      content: content(),
      language: language()?.baseName,
      visibility: visibility(),
      quotePolicy: quotePolicy(),
      actingAccountKey: actingAccountKey(),
      quotedPostId: effectiveQuotedPostId(),
      replyTargetId: props.replyTargetId,
      ensureLinkUrl: props.ensureLinkUrl,
      media: mediaItems(),
      poll: {
        ...poll.snapshot(),
        enabled: canCreatePoll() && poll.enabled(),
      },
    });

  const currentStorableDraftData = (): NoteDraftData => {
    return toStorableNoteDraftData(currentDraftData(), dirty());
  };

  const hasUnstorableMedia = () => hasUnstorableDraftMedia(mediaItems());

  const applyStoredDraft = (draft: StoredNoteDraft) => {
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
      poll.restore(draft.poll, canCreatePoll());
      media.restore(draft.media);
      setEditorResetKey((k) => k + 1);
    });
  };

  const draft = createDraftController({
    active: () => props.draftActive !== false,
    editing: () => !!props.editingNoteId,
    username: viewer.username,
    scope: draftScope,
    dirty,
    snapshot: currentStorableDraftData,
    hasUnstorableMedia,
    apply: applyStoredDraft,
    resetForm,
    resetFormForScope: resetFormForDraftScope,
    onFlushAvailable: () => props.onDraftFlushAvailable,
  });
  const submission = createSubmissionController({
    content,
    media: mediaItems,
    editingNoteId: () => props.editingNoteId,
    editingVisibility: () => props.editingVisibility,
    editingAuthorAccountId: () => props.editingAuthorAccountId,
    language: () => language()?.baseName,
    fallbackLanguage: () => i18n.locale,
    visibility,
    quotePolicy: effectiveQuotePolicy,
    quotedPostId: effectiveQuotedPostId,
    replyTargetId: () => props.replyTargetId,
    ensureLinkUrl: () => props.ensureLinkUrl,
    actingAccountInput,
    prependToConnections: () => props.prependToConnections ?? [],
    appendToConnections: () => props.appendToConnections ?? [],
    viewerId: viewer.id,
    username: viewer.username,
    pollEnabled: () => canCreatePoll() && poll.enabled(),
    validatedPoll: () => getValidatedPollInput(),
    canSwitchToArticle,
    saveDraftNow: draft.saveNow,
    clearDraft: draft.clear,
    resetForm,
    onSuccess: () => props.onSuccess?.(),
    onArticleSwitch: () => {
      setShowArticleSuggestion(false);
      setShowArticleSwitchButton(false);
    },
    navigate,
  });

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
      if (hasFiles(e) && mediaItems().length < MAX_MEDIA) {
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
      if (files) media.addFiles(files);
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

  const handlePaste = (e: ClipboardEvent) => {
    // Check for pasted images first
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      const imageFiles = Array.from(files).filter((f) =>
        isSupportedImageFile(f)
      );
      if (imageFiles.length > 0) {
        e.preventDefault();
        media.addFiles(imageFiles);
        return;
      }
    }

    // Fall through to URL-paste-to-quote logic
    if (props.editingNoteId || effectiveQuotedPostId()) return;
    const clipboardText = e.clipboardData?.getData("text/plain");
    if (clipboardText == null) return;
    // Native textarea paste normalizes CRLF and CR line endings to LF.
    const pastedText = clipboardText.replace(/\r\n?/g, "\n");
    const text = pastedText.trim();
    if (!text || !URL.canParse(text) || !text.match(/^https?:/)) return;
    const target = e.currentTarget;
    if (!(target instanceof HTMLTextAreaElement)) return;
    const pasteStart = target.selectionStart;
    // Keep the browser's native paste so the edit remains in its undo stack.
    // The following input event runs after the default paste action, so it can
    // inspect the inserted range without relying on task or microtask timing.
    target.addEventListener("input", () => {
      const pastedEnd = pasteStart + pastedText.length;
      if (target.value.slice(pasteStart, pastedEnd) !== pastedText) return;
      const pastedRange = { start: pasteStart, end: pastedEnd };
      const removePastedUrl = () => {
        setContent((prev) => {
          if (
            prev.slice(pastedRange.start, pastedRange.end) === pastedText
          ) {
            return prev.slice(0, pastedRange.start) +
              prev.slice(pastedRange.end);
          }
          const firstMatch = prev.indexOf(pastedText);
          if (
            firstMatch >= 0 && firstMatch === prev.lastIndexOf(pastedText)
          ) {
            return prev.slice(0, firstMatch) +
              prev.slice(firstMatch + pastedText.length);
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
    }, { once: true });
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

  createEffect(() => {
    if (props.editingNoteId) poll.reset();
  });

  const getValidatedPollInput = () => {
    const result = poll.validate();
    if (result.ok) return result.value;
    const description = (() => {
      switch (result.error) {
        case "empty-title":
          return t`Poll title cannot be empty`;
        case "empty-option":
          return t`Poll options cannot be empty`;
        case "too-few-options":
          return t`Add at least ${MIN_POLL_OPTIONS} poll options`;
        case "duplicate-options":
          return t`Poll options must be unique`;
        case "invalid-deadline":
          return t`Poll deadline is invalid`;
        case "deadline-too-soon":
          return t`Poll deadline must be at least 1 minute from now`;
      }
    })();
    showToast({ title: t`Error`, description, variant: "error" });
    return null;
  };

  function resetForm() {
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
    media.reset();
    poll.reset();
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

  return (
    <>
      <form
        ref={(el) => (formRef = el)}
        onSubmit={submission.submit}
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

          <TextField>
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
                  const submitting = submission.submitting() ||
                    (!props.editingNoteId && viewer.suspended()) ||
                    mediaItems().some((m) => m.uploading) ||
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
                    disabled={mediaItems().length >= MAX_MEDIA}
                    title={t`Attach image`}
                    aria-label={t`Attach image`}
                    onClick={() => fileInputRef?.click()}
                  >
                    <IconImage class="size-5" />
                  </Button>
                  <Show when={allowPoll()}>
                    <Button
                      type="button"
                      variant={poll.enabled() ? "secondary" : "ghost"}
                      size="icon"
                      title={poll.enabled() ? t`Remove poll` : t`Add poll`}
                      aria-label={poll.enabled() ? t`Remove poll` : t`Add poll`}
                      onClick={() => {
                        if (poll.enabled()) poll.reset();
                        else poll.setEnabled(true);
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
                accept={supportedImageAccept}
                multiple
                class="hidden"
                onChange={(e) => {
                  const files = e.currentTarget.files;
                  if (files) media.addFiles(files);
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

          <Show when={canCreatePoll() && poll.enabled()}>
            <PollEditor poll={poll} />
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
          <Show when={!props.editingNoteId && mediaItems().length > 0}>
            <MediaEditor media={media} />
          </Show>

          <Show
            when={!props.editingNoteId &&
              (draft.meaningful() || draft.hasLocalDraft() ||
                draft.saveStatus() === "unavailable")}
          >
            <div class="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
              <span>
                <Show
                  when={draft.saveStatus() !== "unavailable"}
                  fallback={t`Local draft could not be saved`}
                >
                  {draft.hasLocalDraft() ? t`Saved locally` : t`Local draft`}
                </Show>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                class="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => draft.setShowDeleteConfirm(true)}
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
                onClick={submission.switchToArticleDraft}
                disabled={submission.submitting()}
              >
                <IconFileText class="size-4" />
                {submission.savingArticleDraft()
                  ? t`Saving…`
                  : t`Switch to article`}
              </Button>
            </div>
          </Show>

          <div class="flex min-w-0 gap-2 justify-end">
            <Show when={props.showCancelButton}>
              <Button
                type="button"
                variant="outline"
                onClick={() => props.onCancel?.()}
                disabled={submission.submitting()}
              >
                {t`Cancel`}
              </Button>
            </Show>
            <Button
              type="submit"
              disabled={submission.submitting() ||
                (props.editingNoteId ? !dirty() : (
                  viewer.suspended() ||
                  mediaItems().some((m) => m.uploading) ||
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
                    when={submission.creating() ||
                      submission.creatingQuestion()}
                    fallback={canCreatePoll() && poll.enabled()
                      ? t`Create poll`
                      : t`Create note`}
                  >
                    {t`Creating…`}
                  </Show>
                }
              >
                <Show when={submission.updating()} fallback={t`Save changes`}>
                  {t`Saving…`}
                </Show>
              </Show>
            </Button>
          </div>
        </div>
      </form>

      <AlertDialog
        open={draft.showDeleteConfirm()}
        onOpenChange={(open) => !open && draft.setShowDeleteConfirm(false)}
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
              onClick={draft.deleteAndReset}
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
              onClick={submission.switchToArticleDraft}
              disabled={submission.savingArticleDraft()}
            >
              {submission.savingArticleDraft()
                ? t`Saving…`
                : t`Save as article draft`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
