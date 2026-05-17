import { fetchQuery, graphql } from "relay-runtime";
import { createStore, produce } from "solid-js/store";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createMutation, useRelayEnvironment } from "solid-relay";
import { detectLanguage } from "~/lib/langdet.ts";
import {
  UploadAbortedError,
  uploadMediumFile,
} from "~/lib/uploadMediumWithProgress.ts";
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
import { Button } from "~/components/ui/button.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/components/ui/tabs.tsx";
import {
  TextField,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field.tsx";
import { showToast } from "~/components/ui/toast.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconSquare from "~icons/lucide/square";
import IconX from "~icons/lucide/x";
import type { NoteComposerMutation } from "./__generated__/NoteComposerMutation.graphql.ts";
import type { NoteComposerGeneratedAltTextQuery } from "./__generated__/NoteComposerGeneratedAltTextQuery.graphql.ts";
import type { NoteComposerPostByUrlQuery } from "./__generated__/NoteComposerPostByUrlQuery.graphql.ts";
import type { NoteComposerQuotedPostQuery } from "./__generated__/NoteComposerQuotedPostQuery.graphql.ts";
import type { NoteComposerRenderMarkdownQuery } from "./__generated__/NoteComposerRenderMarkdownQuery.graphql.ts";
import type { NoteComposerReplyTargetQuery } from "./__generated__/NoteComposerReplyTargetQuery.graphql.ts";

const NoteComposerMutation = graphql`
  mutation NoteComposerMutation($input: CreateNoteInput!) {
    createNote(input: $input) {
      __typename
      ... on CreateNotePayload {
        note {
          id
          content
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
  query NoteComposerPostByUrlQuery($url: String!) {
    postByUrl(url: $url) {
      __typename
      id
      viewerCanQuote
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

const NoteComposerRenderMarkdownQuery = graphql`
  query NoteComposerRenderMarkdownQuery($content: String!) {
    renderMarkdown(content: $content)
  }
`;

const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const MAX_MEDIA = 20;

interface MediaItem {
  localId: string;
  file: File;
  previewUrl: string;
  alt: string;
  mediumRelayId?: string;
  uuid?: string;
  uploading: boolean;
  uploadProgress: number;
  generatingAlt: boolean;
  abortUpload?: () => void;
  altSubscription?: { unsubscribe: () => void };
}

interface QuotedPostPreview {
  typename: "Note" | "Article";
  excerpt: string;
  name?: string;
  actorName?: string;
  actorHandle: string;
  actorAvatarUrl: string;
}

export interface NoteComposerProps {
  onSuccess?: () => void;
  onCancel?: () => void;
  onContentChange?: (isDirty: boolean) => void;
  showCancelButton?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  class?: string;
  quotedPostId?: string | null;
  onQuoteRemoved?: () => void;
  replyTargetId?: string | null;
  defaultVisibility?: PostVisibility | null;
  showReplyTarget?: boolean;
}

export function NoteComposer(props: NoteComposerProps) {
  const { t, i18n } = useLingui();
  const environment = useRelayEnvironment();
  const [content, setContent] = createSignal("");
  const [visibility, setVisibility] = createSignal<PostVisibility>(
    props.defaultVisibility ?? "PUBLIC",
  );
  const [quotePolicy, setQuotePolicy] = createSignal<QuotePolicy>("EVERYONE");
  // Keep visibility in sync when the modal is reused for a different reply/quote
  createEffect(() => {
    const v = props.defaultVisibility;
    if (v != null) setVisibility(v);
  });
  const effectiveQuotePolicy = () =>
    visibility() === "PUBLIC" || visibility() === "UNLISTED"
      ? quotePolicy()
      : "SELF";
  const [language, setLanguage] = createSignal<Intl.Locale | undefined>(
    new Intl.Locale(i18n.locale),
  );
  const [manualLanguageChange, setManualLanguageChange] = createSignal(false);
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
  let prefillRef = "";
  const [createNote, isCreating] = createMutation<NoteComposerMutation>(
    NoteComposerMutation,
  );
  const [mediaItems, setMediaItems] = createStore<MediaItem[]>([]);
  const [isDraggingOver, setIsDraggingOver] = createSignal(false);
  const [activeTab, setActiveTab] = createSignal<string>("write");
  const [previewHtml, setPreviewHtml] = createSignal<string>("");
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewError, setPreviewError] = createSignal(false);
  let lastRenderedText = "";
  let lastRenderedHtml = "";
  let previewRequestVersion = 0;
  let previewSubscription: { unsubscribe: () => void } | undefined;
  let formRef: HTMLFormElement | undefined;
  let removeDragListeners: (() => void) | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;

  onCleanup(() => {
    previewSubscription?.unsubscribe();
    removeDragListeners?.();
    for (const item of mediaItems) {
      item.abortUpload?.();
      item.altSubscription?.unsubscribe();
      URL.revokeObjectURL(item.previewUrl);
    }
  });

  // Notify parent when dirty state changes (user has typed or attached media
  // beyond the auto-filled mention prefix).
  createEffect(() => {
    const dirty =
      (content().trim() !== "" && content().trim() !== prefillRef.trim()) ||
      mediaItems.length > 0;
    props.onContentChange?.(dirty);
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
          (node.__typename !== "Note" && node.__typename !== "Article")
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
      // Clear the pre-filled mentions if the user hasn't overwritten them
      if (content() === prefillRef) setContent("");
      prefillRef = "";
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
      const localId = crypto.randomUUID();
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
            m.abortUpload = undefined;
          }
        }));
      }).catch((err) => {
        if (err instanceof UploadAbortedError) return;
        setMediaItems(produce((items) => {
          const idx = items.findIndex((m) => m.localId === localId);
          if (idx !== -1) {
            URL.revokeObjectURL(items[idx].previewUrl);
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
    if (effectiveQuotedPostId()) return;
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
      { url: text },
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

  const resetForm = () => {
    for (const item of mediaItems) {
      item.abortUpload?.();
      item.altSubscription?.unsubscribe();
      URL.revokeObjectURL(item.previewUrl);
    }
    prefillRef = "";
    setContent("");
    setVisibility(props.defaultVisibility ?? "PUBLIC");
    setQuotePolicy("EVERYONE");
    setLanguage(new Intl.Locale(i18n.locale));
    setManualLanguageChange(false);
    setQuotedPost(null);
    setPastedQuoteId(null);
    setQuoteFetchError(false);
    setReplyTargetPost(null);
    setReplyTargetFetchError(false);
    setMediaItems([]);
    previewSubscription?.unsubscribe();
    previewSubscription = undefined;
    lastRenderedText = "";
    lastRenderedHtml = "";
    setActiveTab("write");
    setPreviewHtml("");
    setPreviewError(false);
    setPreviewLoading(false);
  };

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
    previewSubscription?.unsubscribe();
    previewSubscription = undefined;
    if (tab !== "preview") {
      setPreviewLoading(false);
      return;
    }
    const text = content().trim();
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
    previewSubscription = fetchQuery<NoteComposerRenderMarkdownQuery>(
      environment(),
      NoteComposerRenderMarkdownQuery,
      { content: text },
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
        setPreviewHtml("");
        setPreviewLoading(false);
      },
    });
  };

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

    createNote({
      variables: {
        input: {
          content: noteContent,
          language: language()?.baseName ?? i18n.locale,
          visibility: visibility(),
          quotePolicy: effectiveQuotePolicy(),
          quotedPostId: effectiveQuotedPostId() ?? null,
          replyTargetId: props.replyTargetId ?? null,
          media: items.map((m) => ({
            mediumId: m
              .uuid! as `${string}-${string}-${string}-${string}-${string}`,
            alt: m.alt.trim(),
          })),
        },
      },
      onCompleted(response) {
        if (response.createNote.__typename === "CreateNotePayload") {
          showToast({
            title: t`Success`,
            description: t`Note created successfully`,
            variant: "success",
          });
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
    <form
      ref={(el) => (formRef = el)}
      onSubmit={handleSubmit}
      class={props.class}
    >
      <div
        class={`grid gap-4 rounded-lg transition-colors ${
          isDraggingOver()
            ? "outline outline-2 outline-dashed outline-primary"
            : ""
        }`}
      >
        {/* Reply target preview */}
        <Show when={props.replyTargetId && props.showReplyTarget !== false}>
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

        {/* Quoted post preview */}
        <Show when={effectiveQuotedPostId()}>
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

        <Tabs value={activeTab()} onChange={handleTabChange}>
          <TextField>
            <TextFieldLabel class="sr-only">{t`Content`}</TextFieldLabel>
            <TabsList class="h-8 w-full p-0.5 mb-1">
              <TabsTrigger value="write" class="flex-1 text-xs">
                {t`Write`}
              </TabsTrigger>
              <TabsTrigger
                value="preview"
                class="flex-1 text-xs"
              >
                {t`Preview`}
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="write"
              class="mt-0 hidden data-[selected]:block"
              forceMount
            >
              <TextFieldTextArea
                ref={(el) => (textareaRef = el)}
                value={content()}
                onInput={(e) => setContent(e.currentTarget.value)}
                onPaste={handlePaste}
                onWheel={(e) => {
                  // Prevent solid-prevent-scroll's document listener from blocking scroll.
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
                class="min-h-[150px]"
              />
              <MentionAutocomplete
                textareaRef={() => textareaRef}
                onComplete={() => {
                  if (textareaRef) setContent(textareaRef.value);
                }}
              />
            </TabsContent>
            <TabsContent value="preview" class="mt-0">
              <Show
                when={!previewLoading()}
                fallback={
                  <div class="min-h-[150px] flex items-center justify-center text-muted-foreground text-sm rounded-md border border-input">
                    {t`Rendering…`}
                  </div>
                }
              >
                <Show
                  when={previewHtml()}
                  fallback={
                    <div class="min-h-[150px] flex items-center justify-center text-muted-foreground text-sm rounded-md border border-input">
                      {previewError()
                        ? t`Failed to render preview`
                        : t`Nothing to preview`}
                    </div>
                  }
                >
                  <div
                    innerHTML={previewHtml()}
                    class="prose dark:prose-invert prose-sm min-h-[150px] max-w-none rounded-md border border-input px-3 py-2 text-sm"
                  />
                </Show>
              </Show>
            </TabsContent>
            <div class="flex items-center justify-between mt-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={mediaItems.length >= MAX_MEDIA}
                title={t`Attach image`}
                aria-label={t`Attach image`}
                onClick={() => fileInputRef?.click()}
              >
                {/* Heroicons outline: photo */}
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="1.5"
                  stroke="currentColor"
                  class="size-6"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
                  />
                </svg>
              </Button>
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
        </Tabs>

        {/* Toolbar: language, visibility, quote policy */}
        <div class="flex flex-wrap items-center gap-2">
          <LanguageSelect
            value={language()}
            onChange={handleLanguageChange}
            class="flex-1 min-w-[8rem]"
          />
          <NoteVisibilityQuotePolicySelect
            visibility={visibility()}
            quotePolicy={quotePolicy()}
            onVisibilityChange={setVisibility}
            onQuotePolicyChange={setQuotePolicy}
          />
        </div>

        {/* Media previews */}
        <Show when={mediaItems.length > 0}>
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
                          URL.revokeObjectURL(item.previewUrl);
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

        <div class="flex gap-2 justify-end">
          <Show when={props.showCancelButton}>
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onCancel?.()}
              disabled={isCreating()}
            >
              {t`Cancel`}
            </Button>
          </Show>
          <Button
            type="submit"
            disabled={isCreating() ||
              mediaItems.some((m) => m.uploading) ||
              (!!effectiveQuotedPostId() && !quotedPost() &&
                !quoteFetchError()) ||
              (!!props.replyTargetId && props.showReplyTarget !== false &&
                !replyTargetPost() && !replyTargetFetchError())}
          >
            <Show when={isCreating()} fallback={t`Create note`}>
              {t`Creating…`}
            </Show>
          </Button>
        </div>
      </div>
    </form>
  );
}
