import { Show } from "solid-js";
import { useLingui } from "~/lib/i18n/macro.d.ts";
import IconClock from "~icons/lucide/clock";
import IconEyeOff from "~icons/lucide/eye-off";

export interface QuoteTargetPlaceholderProps {
  readonly state: "PENDING" | "DENIED" | "%future added value";
  readonly class?: string;
}

export function QuoteTargetPlaceholder(props: QuoteTargetPlaceholderProps) {
  const { t } = useLingui();
  const pending = () => props.state === "PENDING";

  return (
    <div
      class={`mt-4 rounded-lg border border-dashed bg-muted/35 px-4 py-3 text-muted-foreground ${
        props.class ?? ""
      }`}
    >
      <div class="flex gap-3">
        <div class="mt-0.5 shrink-0">
          <Show when={pending()} fallback={<IconEyeOff class="size-4" />}>
            <IconClock class="size-4" />
          </Show>
        </div>
        <div class="min-w-0 space-y-1">
          <p class="text-sm font-medium text-foreground">
            {pending()
              ? t`Quoted post awaiting approval`
              : t`Quoted post hidden`}
          </p>
          <p class="text-sm leading-5">
            {pending()
              ? t`This quote is waiting for approval from the original author.`
              : t`This post quoted another post, but the quote is not currently authorized.`}
          </p>
        </div>
      </div>
    </div>
  );
}
