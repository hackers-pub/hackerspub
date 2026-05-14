import { createEffect, createSignal } from "solid-js";
import { NoteComposer } from "~/components/NoteComposer.tsx";
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

  const [isDirty, setIsDirty] = createSignal(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = createSignal(false);

  // Reset dirty state whenever the dialog closes.
  createEffect(() => {
    if (!isOpen()) {
      setIsDirty(false);
      setShowDiscardConfirm(false);
    }
  });

  const handleSuccess = () => {
    notifyNoteCreated();
    close();
  };

  // Intercept close attempts: show confirmation if the composer is dirty.
  const handleClose = () => {
    if (isDirty()) {
      setShowDiscardConfirm(true);
    } else {
      close();
    }
  };

  const handleDiscard = () => {
    setShowDiscardConfirm(false);
    setIsDirty(false);
    close();
  };

  const dialogTitle = () => {
    if (replyTargetId()) return t`Reply`;
    if (quotedPostId()) return t`Quote`;
    return t`Create note`;
  };

  return (
    <>
      <Dialog open={isOpen()} onOpenChange={(open) => !open && handleClose()}>
        <DialogContent
          class="sm:max-w-2xl"
          onPointerDownOutside={(e) => {
            // Prevent the dialog from closing when the user clicks a
            // mention autocomplete suggestion, which renders in a Portal
            // outside the dialog's DOM tree.
            const portal = document.getElementById(
              "mention-autocomplete-portal",
            );
            if (
              e.detail.originalEvent.target instanceof Node &&
              portal?.contains(e.detail.originalEvent.target)
            ) {
              e.preventDefault();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{dialogTitle()}</DialogTitle>
          </DialogHeader>
          <div class="py-4">
            <NoteComposer
              onSuccess={handleSuccess}
              onCancel={handleClose}
              onContentChange={setIsDirty}
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

      <AlertDialog
        open={showDiscardConfirm()}
        onOpenChange={(open) => !open && setShowDiscardConfirm(false)}
      >
        <AlertDialogContent class="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Discard draft?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`Your unsaved draft will be lost.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose>{t`Keep editing`}</AlertDialogClose>
            <AlertDialogAction
              class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDiscard}
            >
              {t`Discard`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
