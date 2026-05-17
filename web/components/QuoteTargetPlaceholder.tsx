import type { QuoteTargetState } from "@hackerspub/models/schema";
import { Msg } from "./Msg.tsx";

export interface QuoteTargetPlaceholderProps {
  state: QuoteTargetState;
  class?: string;
}

export function QuoteTargetPlaceholder(props: QuoteTargetPlaceholderProps) {
  const pending = props.state === "pending";
  return (
    <div
      class={`
        border border-dashed border-stone-300 bg-stone-100
        px-4 py-3 text-stone-500 dark:border-stone-700
        dark:bg-stone-800 dark:text-stone-400
        ${props.class ?? ""}
      `}
    >
      <p class="font-semibold text-stone-900 dark:text-stone-100">
        <Msg
          $key={pending
            ? "quoteTarget.pendingTitle"
            : "quoteTarget.deniedTitle"}
        />
      </p>
      <p class="mt-1 text-sm leading-5">
        <Msg
          $key={pending ? "quoteTarget.pendingBody" : "quoteTarget.deniedBody"}
        />
      </p>
    </div>
  );
}
