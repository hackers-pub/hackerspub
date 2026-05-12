import { createSignal, type JSX, onCleanup, Show } from "solid-js";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "~/components/ui/hover-card.tsx";
import { cn } from "~/lib/utils.ts";
import { ActorHoverCardLoader } from "./ActorHoverCardLoader.tsx";

const TOUCH_FOCUS_SUPPRESSION_MS = 1_000;

export interface ActorHoverCardProps {
  /** Canonical fediverse handle (e.g., `@user@host`). */
  handle: string;
  /**
   * Extra classes for the trigger wrapper. Append `shrink-0` when wrapping a
   * fixed-size avatar in a flex container so the wrapper itself does not
   * collapse.
   */
  class?: string;
  children: JSX.Element;
}

export function ActorHoverCard(props: ActorHoverCardProps) {
  const [open, setOpen] = createSignal(false);
  // Touch taps can focus the inner link, and Kobalte opens hover cards on
  // focus after a delay; suppress only that delayed touch-triggered open.
  let suppressTouchFocusOpen = false;
  let touchFocusSuppressionTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTouchFocusSuppression = () => {
    if (touchFocusSuppressionTimer !== undefined) {
      clearTimeout(touchFocusSuppressionTimer);
      touchFocusSuppressionTimer = undefined;
    }
  };

  const suppressTouchFocusOpenTemporarily = () => {
    suppressTouchFocusOpen = true;
    setOpen(false);
    clearTouchFocusSuppression();
    touchFocusSuppressionTimer = setTimeout(() => {
      suppressTouchFocusOpen = false;
      touchFocusSuppressionTimer = undefined;
    }, TOUCH_FOCUS_SUPPRESSION_MS);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && suppressTouchFocusOpen) return;
    setOpen(nextOpen);
  };

  const handleTriggerPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") {
      suppressTouchFocusOpenTemporarily();
    }
  };

  onCleanup(clearTouchFocusSuppression);

  return (
    <HoverCard open={open()} onOpenChange={handleOpenChange}>
      <HoverCardTrigger
        as="span"
        class={cn("inline-flex self-start", props.class)}
        role="presentation"
        tabIndex={-1}
        onPointerDown={handleTriggerPointerDown}
      >
        {props.children}
      </HoverCardTrigger>
      <HoverCardContent>
        <Show when={open()}>
          <ActorHoverCardLoader handle={props.handle} />
        </Show>
      </HoverCardContent>
    </HoverCard>
  );
}
