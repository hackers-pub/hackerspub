import type { ValidComponent } from "solid-js";
import { type Component, splitProps } from "solid-js";

import * as HoverCardPrimitive from "@kobalte/core/hover-card";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";

import { cn } from "~/lib/utils.ts";

const HoverCardTrigger = HoverCardPrimitive.Trigger;

const HoverCard: Component<HoverCardPrimitive.HoverCardRootProps> = (
  props,
) => {
  return <HoverCardPrimitive.Root gutter={4} {...props} />;
};

type HoverCardContentProps<T extends ValidComponent = "div"> =
  & HoverCardPrimitive.HoverCardContentProps<T>
  & { class?: string | undefined };

const HoverCardContent = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, HoverCardContentProps<T>>,
) => {
  const [local, others] = splitProps(props as HoverCardContentProps, ["class"]);
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Content
        class={cn(
          "z-50 origin-[var(--kb-hovercard-content-transform-origin)] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[expanded]:animate-content-show data-[closed]:animate-content-hide",
          local.class,
        )}
        {...others}
      />
    </HoverCardPrimitive.Portal>
  );
};

export { HoverCard, HoverCardContent, HoverCardTrigger };
