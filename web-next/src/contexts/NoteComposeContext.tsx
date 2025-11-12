import {
  createContext,
  createSignal,
  ParentComponent,
  useContext,
} from "solid-js";

type NoteCreatedCallback = () => void;

interface NoteComposeContextValue {
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  onNoteCreated: (callback: NoteCreatedCallback) => () => void;
  notifyNoteCreated: () => void;
}

const NoteComposeContext = createContext<NoteComposeContextValue>();

export const NoteComposeProvider: ParentComponent = (props) => {
  const [isOpen, setIsOpen] = createSignal(false);
  const [callbacks, setCallbacks] = createSignal<Set<NoteCreatedCallback>>(
    new Set(),
  );

  const open = () => {
    setIsOpen(true);
  };
  const close = () => {
    setIsOpen(false);
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
      value={{ isOpen, open, close, onNoteCreated, notifyNoteCreated }}
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
