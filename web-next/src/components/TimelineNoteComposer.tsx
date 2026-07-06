import { NoteComposer } from "~/components/NoteComposer.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";

export function TimelineNoteComposer() {
  const { notifyNoteCreated } = useNoteCompose();

  return (
    <div class="mt-4 overflow-hidden border bg-card md:rounded-lg md:shadow-sm">
      <div class="px-3 py-4 sm:px-4">
        <NoteComposer onSuccess={notifyNoteCreated} />
      </div>
    </div>
  );
}
