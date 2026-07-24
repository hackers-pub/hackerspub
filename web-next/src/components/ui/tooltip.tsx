import type { ValidComponent } from "solid-js";
import {
  type Component,
  createSignal,
  onMount,
  Show,
  splitProps,
} from "solid-js";

import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as TooltipPrimitive from "@kobalte/core/tooltip";

import { cn } from "~/lib/utils.ts";

const TooltipTrigger = TooltipPrimitive.Trigger;

const Tooltip: Component<TooltipPrimitive.TooltipRootProps> = (props) => {
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));

  // Kobalte tooltips contain Polymorphic/Dynamic nodes; an SSR/client shape
  // mismatch causes Solid to hydrate a dynamic element that was never rendered
  // and crash in getNextElement(), or pass a stale non-Element ref into
  // FloatingUI's getComputedStyle (throws on Safari 18.5+).
  return (
    <Show when={mounted()}>
      <TooltipPrimitive.Root gutter={4} {...props} />
    </Show>
  );
};

type TooltipContentProps<T extends ValidComponent = "div"> =
  TooltipPrimitive.TooltipContentProps<T> & { class?: string | undefined };

const TooltipContent = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, TooltipContentProps<T>>,
) => {
  const [local, others] = splitProps(props as TooltipContentProps, ["class"]);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        class={cn(
          "z-50 origin-[var(--kb-popover-content-transform-origin)] overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95",
          local.class,
        )}
        {...others}
      />
    </TooltipPrimitive.Portal>
  );
};

export { Tooltip, TooltipContent, TooltipTrigger };
