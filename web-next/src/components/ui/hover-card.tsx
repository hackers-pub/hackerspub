import type { ValidComponent } from "solid-js";
import { type Component, splitProps } from "solid-js";

import * as HoverCardPrimitive from "@kobalte/core/hover-card";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";

import { cn } from "~/lib/utils.ts";

/**
 * Shared surface classes for the profile hover-card content. Reused by
 * `MentionHoverCardLayer` (which uses Kobalte `Popover` instead of
 * `HoverCard`) so both surfaces stay visually identical. Append the
 * primitive-specific transform-origin variable when applying.
 */
export const ACTOR_HOVER_SURFACE_CLASS =
  "z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95";

const HoverCardTrigger = HoverCardPrimitive.Trigger;

const HoverCard: Component<HoverCardPrimitive.HoverCardRootProps> = (props) => {
  return (
    <HoverCardPrimitive.Root
      placement="bottom"
      gutter={4}
      openDelay={400}
      closeDelay={200}
      {...props}
    />
  );
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
          ACTOR_HOVER_SURFACE_CLASS,
          "origin-[var(--kb-hovercard-content-transform-origin)]",
          local.class,
        )}
        {...others}
      />
    </HoverCardPrimitive.Portal>
  );
};

export { HoverCard, HoverCardContent, HoverCardTrigger };
