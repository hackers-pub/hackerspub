import {
  createContext,
  createSignal,
  ParentComponent,
  useContext,
} from "solid-js";

type NoteCreatedCallback = () => void;

interface NoteComposeContextValue {
  isOpen: () => boolean;
  quotedPostId: () => string | null;
  open: (quotedPostId?: string) => void;
  close: () => void;
  clearQuote: () => void;
  onNoteCreated: (callback: NoteCreatedCallback) => () => void;
  notifyNoteCreated: () => void;
}

const NoteComposeContext = createContext<NoteComposeContextValue>();

export const NoteComposeProvider: ParentComponent = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [quotedPostId, setQuotedPostId] = createSignal<string | null>(null);
  const [callbacks, setCallbacks] = createSignal<Set<NoteCreatedCallback>>(
    new Set(),
  );

  const open = (quotedPostId?: string) => {
    setQuotedPostId(quotedPostId ?? null);
    setIsOpen(true);
  };
  const close = () => {
    setQuotedPostId(null);
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
        open,
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
