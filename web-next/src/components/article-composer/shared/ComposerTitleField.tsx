import { useLingui } from "~/lib/i18n/macro.ts";

export interface ComposerTitleFieldProps {
  value: string;
  onInput: (value: string) => void;
  placeholder: string;
}

/**
 * The full-bleed title row that sits at the top of the composer. Borderless and
 * large; separation from the panes below comes from the row's `border-b`.
 */
export function ComposerTitleField(props: ComposerTitleFieldProps) {
  const { t } = useLingui();
  return (
    <div class="shrink-0 border-b px-4 py-4 sm:px-6">
      <input
        type="text"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        placeholder={props.placeholder}
        aria-label={t`Title`}
        class="w-full bg-transparent text-xl font-semibold placeholder:text-muted-foreground/50 focus:outline-none sm:text-2xl"
      />
    </div>
  );
}
