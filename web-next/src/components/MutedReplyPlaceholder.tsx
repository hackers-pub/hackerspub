import { Button } from "~/components/ui/button.tsx";
import { useLingui } from "~/lib/i18n/macro.ts";
import IconVolumeX from "~icons/lucide/volume-x";

export interface MutedReplyPlaceholderProps {
  /** The muted author's fediverse handle, shown in the placeholder text. */
  readonly handle: string;
  /** Called when the viewer chooses to reveal the hidden reply. */
  readonly onReveal: () => void;
}

/**
 * Stands in for a reply authored by an actor the viewer has muted. Muting hides
 * the reply's content but, unlike blocking, keeps a visible indicator that
 * something was hidden plus a one-tap way to reveal it. Render this in place of
 * the reply card; the surrounding row/border is supplied by the caller.
 */
export function MutedReplyPlaceholder(props: MutedReplyPlaceholderProps) {
  const { t } = useLingui();
  return (
    <div class="flex items-center gap-3 px-4 py-3 text-sm text-muted-foreground">
      <IconVolumeX class="size-4 shrink-0" />
      <p class="grow min-w-0">
        {t`This reply is hidden because you muted ${props.handle}.`}
      </p>
      <Button
        variant="outline"
        size="sm"
        class="shrink-0"
        onClick={() => props.onReveal()}
      >
        {t`Show`}
      </Button>
    </div>
  );
}
