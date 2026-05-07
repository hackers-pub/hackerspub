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
  const {
    isOpen,
    quotedPostId,
    replyTargetId,
    replyDefaultVisibility,
    close,
    clearQuote,
    notifyNoteCreated,
  } = useNoteCompose();

  const handleSuccess = () => {
    notifyNoteCreated();
    close();
  };

  const dialogTitle = () => {
    if (replyTargetId()) return t`Reply`;
    if (quotedPostId()) return t`Quote`;
    return t`Create note`;
  };

  return (
    <Dialog open={isOpen()} onOpenChange={(open) => open ? null : close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialogTitle()}</DialogTitle>
        </DialogHeader>
        <div class="py-4">
          <NoteComposer
            onSuccess={handleSuccess}
            onCancel={close}
            showCancelButton
            autoFocus
            quotedPostId={quotedPostId()}
            onQuoteRemoved={clearQuote}
            replyTargetId={replyTargetId()}
            defaultVisibility={replyDefaultVisibility() ?? undefined}
            placeholder={replyTargetId() ? t`Write a reply…` : undefined}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
