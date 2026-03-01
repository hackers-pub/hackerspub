import { NoteComposer } from "~/components/NoteComposer.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog.tsx";
import { useNoteCompose } from "~/contexts/NoteComposeContext.tsx";
import { useLingui } from "~/lib/i18n/macro.d.ts";

export function NoteComposeModal() {
  const { t } = useLingui();
  const { isOpen, quotedPostId, close, clearQuote, notifyNoteCreated } =
    useNoteCompose();

  const handleSuccess = () => {
    notifyNoteCreated();
    close();
  };

  return (
    <Dialog open={isOpen()} onOpenChange={(open) => open ? null : close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {quotedPostId() ? t`Quote` : t`Create Note`}
          </DialogTitle>
        </DialogHeader>
        <div class="py-4">
          <NoteComposer
            onSuccess={handleSuccess}
            onCancel={close}
            showCancelButton
            autoFocus
            quotedPostId={quotedPostId()}
            onQuoteRemoved={clearQuote}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
