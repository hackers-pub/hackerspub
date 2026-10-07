import { createSignal, For } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.ts";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox, CheckboxLabel } from "./ui/checkbox.tsx";
interface RecoveryCodesDialogProps {
  codes: readonly string[];
  onSaved: () => void;
}
export function RecoveryCodesDialog(props: RecoveryCodesDialogProps) {
  const { t } = useLingui();
  const [saved, setSaved] = createSignal(false);
  const [message, setMessage] = createSignal("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.codes.join("\n"));
      setMessage(t`Recovery codes copied.`);
    } catch {
      setMessage(t`Copy failed. Download or write down your recovery codes.`);
    }
  }
  function download() {
    const url = URL.createObjectURL(
      new Blob([props.codes.join("\n") + "\n"], { type: "text/plain" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "hackerspub-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t`Save your recovery codes`}</AlertDialogTitle>
          <AlertDialogDescription>{t`Each code works once. These codes will not be shown again. Store them somewhere safe, separately from your passkeys.`}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul class="grid gap-2 font-mono text-sm">
          <For each={props.codes}>{(code) => <li>{code}</li>}</For>
        </ul>
        <div class="flex flex-wrap gap-2">
          <Button variant="outline" onClick={copy}>{t`Copy codes`}</Button>
          <Button
            variant="outline"
            onClick={download}
          >{t`Download codes`}</Button>
        </div>
        <p role="status">{message()}</p>
        <Checkbox checked={saved()} onChange={setSaved}>
          <CheckboxLabel>{t`I have saved my recovery codes`}</CheckboxLabel>
        </Checkbox>
        <Button disabled={!saved()} onClick={props.onSaved}>{t`Done`}</Button>
      </AlertDialogContent>
    </AlertDialog>
  );
}
