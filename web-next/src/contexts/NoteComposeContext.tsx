import {
  createContext,
  createSignal,
  ParentComponent,
  useContext,
} from "solid-js";
import type { PostVisibility } from "~/components/PostVisibilitySelect.tsx";
import type { QuotePolicy } from "~/components/QuotePolicySelect.tsx";

type NoteCreatedCallback = () => void;

export interface NoteEditInitialData {
  content: string;
  language: string | null | undefined;
  quotePolicy: QuotePolicy;
  visibility: PostVisibility;
}

interface NoteComposeContextValue {
  isOpen: () => boolean;
  quotedPostId: () => string | null;
  replyTargetId: () => string | null;
  replyDefaultVisibility: () => PostVisibility | null;
  editingNoteId: () => string | null;
  editInitialData: () => NoteEditInitialData | null;
  initialContent: () => string | null;
  open: () => void;
  openWithContent: (content: string) => void;
  openWithQuote: (quotedPostId: string) => void;
  openWithReply: (
    replyTargetId: string,
    defaultVisibility: PostVisibility,
  ) => void;
  openForEdit: (noteId: string, data: NoteEditInitialData) => void;
  close: () => void;
  clearQuote: () => void;
  onNoteCreated: (callback: NoteCreatedCallback) => () => void;
  notifyNoteCreated: () => void;
}

const NoteComposeContext = createContext<NoteComposeContextValue>();

export const NoteComposeProvider: ParentComponent = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [quotedPostId, setQuotedPostId] = createSignal<string | null>(null);
  const [replyTargetId, setReplyTargetId] = createSignal<string | null>(null);
  const [replyDefaultVisibility, setReplyDefaultVisibility] = createSignal<
    PostVisibility | null
  >(null);
  const [editingNoteId, setEditingNoteId] = createSignal<string | null>(null);
  const [editInitialData, setEditInitialData] = createSignal<
    NoteEditInitialData | null
  >(null);
  const [initialContent, setInitialContent] = createSignal<string | null>(null);
  const [callbacks, setCallbacks] = createSignal<Set<NoteCreatedCallback>>(
    new Set(),
  );

  const open = () => {
    setQuotedPostId(null);
    setReplyTargetId(null);
    setReplyDefaultVisibility(null);
    setEditingNoteId(null);
    setEditInitialData(null);
    setInitialContent(null);
    setIsOpen(true);
  };
  const openWithContent = (content: string) => {
    setQuotedPostId(null);
    setReplyTargetId(null);
    setReplyDefaultVisibility(null);
    setEditingNoteId(null);
    setEditInitialData(null);
    setInitialContent(content);
    setIsOpen(true);
  };
  const openWithQuote = (quotedPostId: string) => {
    setQuotedPostId(quotedPostId);
    setReplyTargetId(null);
    setReplyDefaultVisibility(null);
    setEditingNoteId(null);
    setEditInitialData(null);
    setInitialContent(null);
    setIsOpen(true);
  };
  const openWithReply = (
    id: string,
    defaultVisibility: PostVisibility,
  ) => {
    setQuotedPostId(null);
    setReplyTargetId(id);
    setReplyDefaultVisibility(defaultVisibility);
    setEditingNoteId(null);
    setEditInitialData(null);
    setInitialContent(null);
    setIsOpen(true);
  };
  const openForEdit = (noteId: string, data: NoteEditInitialData) => {
    setQuotedPostId(null);
    setReplyTargetId(null);
    setReplyDefaultVisibility(null);
    setEditingNoteId(noteId);
    setEditInitialData(data);
    setInitialContent(null);
    setIsOpen(true);
  };
  const close = () => {
    setQuotedPostId(null);
    setReplyTargetId(null);
    setReplyDefaultVisibility(null);
    setEditingNoteId(null);
    setEditInitialData(null);
    setInitialContent(null);
    setIsOpen(false);
  };
  const clearQuote = () => {
    setQuotedPostId(null);
  };

  const onNoteCreated = (callback: NoteCreatedCallback) => {
    setCallbacks((prev) => new Set(prev).add(callback));
    // Return cleanup function
    return () => {
      setCallbacks((prev) => {
        const next = new Set(prev);
        next.delete(callback);
        return next;
      });
    };
  };

  const notifyNoteCreated = () => {
    callbacks().forEach((callback) => callback());
  };

  return (
    <NoteComposeContext.Provider
      value={{
        isOpen,
        quotedPostId,
        replyTargetId,
        replyDefaultVisibility,
        editingNoteId,
        editInitialData,
        initialContent,
        open,
        openWithContent,
        openWithQuote,
        openWithReply,
        openForEdit,
        close,
        clearQuote,
        onNoteCreated,
        notifyNoteCreated,
      }}
    >
      {props.children}
    </NoteComposeContext.Provider>
  );
};

export function useNoteCompose() {
  const context = useContext(NoteComposeContext);
  if (!context) {
    throw new Error("useNoteCompose must be used within a NoteComposeProvider");
  }
  return context;
}
