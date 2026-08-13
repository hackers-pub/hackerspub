import { REACTION_EMOJIS } from "@hackerspub/models/emoji";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
} from "solid-js";
import IconLoader2 from "~icons/lucide/loader-2";
import { useLingui } from "~/lib/i18n/macro.ts";
import { createOutsideDismiss } from "~/lib/outsideDismiss.ts";
import {
  getViewportQuickBarPosition,
  type PopoverPosition,
} from "~/lib/popoverPosition.ts";
import { createViewportReposition } from "~/lib/viewportReposition.ts";
import {
  INITIAL_GESTURE,
  LONG_PRESS_DELAY,
  type QuickReactionGestureEffect,
  type QuickReactionGestureEvent,
  reduceQuickReactionGesture,
} from "./quickReactionGesture.ts";

export interface QuickReactionGroup {
  readonly emoji: string;
  readonly count: number;
  readonly viewerHasReacted: boolean;
}

export interface QuickReactionBarProps {
  /**
   * Unicode emoji reaction groups already present on the post.  Custom
   * emoji groups are not offered in the quick bar.
   */
  reactions: ReadonlyArray<QuickReactionGroup>;
  /**
   * Whether the viewer has reacted to the post with any emoji, including
   * custom emojis the quick bar does not list.  Defaults to deriving from
   * `reactions`, which misses custom emoji reactions.
   */
  viewerHasReacted?: boolean;
  /**
   * The unicode emoji whose toggle round-trip is in flight, or `null`.
   * The matching button shows a spinner until the mutation settles.
   */
  pendingEmoji?: string | null;
  disabled?: boolean;
  /**
   * Toggles the viewer's reaction for `emoji`.  The bar stays open after
   * a toggle because Hackers' Pub allows several reactions per viewer on
   * the same post.
   */
  onToggleReaction: (emoji: string) => void;
}

// Hover-intent delays: the open delay keeps the bar from flashing while
// the pointer crosses the timeline; the close delay covers the gap
// between the trigger and the floating bar.
const OPEN_DELAY = 100;
const CLOSE_DELAY = 300;
const VIEWPORT_MARGIN = 4;

/**
 * Reaction trigger for the timeline engagement bar.  Hovering the heart
 * (mouse pointers only) reveals a quick-pick row of the default reaction
 * emojis above the trigger; on touch devices pressing and holding the
 * heart reveals the row while the finger is still down, sliding the
 * finger then highlights the emoji under it instead of scrolling the
 * page, and releasing over an emoji commits that reaction.  A plain
 * tap toggles the row, and tapping anywhere outside dismisses it.
 * Keyboard users get the row on focus and can dismiss it with Escape.
 *
 * The row is fixed-positioned from the trigger's viewport rect (clamped
 * by `getViewportQuickBarPosition`) so it escapes `overflow-hidden`
 * ancestors and never runs off narrow screens, but it stays a DOM child
 * of the wrapper so the hover/focus containment logic keeps working.
 */
export function QuickReactionBar(props: QuickReactionBarProps) {
  const { t } = useLingui();
  const [open, setOpen] = createSignal(false);
  const [animateEntrance, setAnimateEntrance] = createSignal(false);
  const [rowPosition, setRowPosition] = createSignal<PopoverPosition | null>(
    null,
  );
  const rowId = createUniqueId();
  let wrapper: HTMLDivElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let row: HTMLDivElement | undefined;
  // scheduleOpen and scheduleClose cancel each other, so a single hover
  // timer models the one pending hover intent; the long-press timer is
  // separate because the gesture machine arms and clears only it.
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let longPressTimer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimers = () => {
    clearTimeout(hoverTimer);
    clearTimeout(longPressTimer);
  };
  onCleanup(cancelTimers);

  const dismiss = () => {
    clearTimeout(hoverTimer);
    dispatchGesture({ type: "dismiss" });
    setOpen(false);
  };

  const openRow = (animated: boolean) => {
    setAnimateEntrance(animated);
    setOpen(true);
  };

  // The slide session keeps the finger that long-pressed the heart in
  // charge after the row opens: the row button under the finger is
  // tracked for highlight and receives a click on release, so tap and
  // slide share the buttons' onClick handlers as the one commit path.
  const [slideButton, setSlideButton] = createSignal<HTMLElement | null>(null);
  let slideSessionAbort: AbortController | undefined;

  const slideActive = (id: string) =>
    slideButton()?.dataset.slideTarget === id ? "" : undefined;

  const endSlideSession = () => {
    slideSessionAbort?.abort();
    setSlideButton(null);
  };
  onCleanup(endSlideSession);

  const beginSlideSession = (pointerId: number) => {
    endSlideSession();
    if (trigger == null) return;
    const controller = new AbortController();
    slideSessionAbort = controller;
    // Non-passive on purpose: preventDefault here is what stops the
    // browser from starting a scroll once the held finger moves, and it
    // only works because the pan has not begun yet (the finger held
    // still through the long press).  With the pan suppressed, pointer
    // events keep flowing instead of ending in pointercancel.
    const onTouchMove = (event: TouchEvent) => {
      if (event.cancelable) event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      setSlideButton(
        el != null && row?.contains(el)
          ? el.closest<HTMLElement>("[data-slide-target]")
          : null,
      );
    };
    // Only movement needs listening for: the release arrives through the
    // trigger's own pointerup/pointercancel handlers, which the touch's
    // implicit pointer capture retargets here even when the finger ends
    // somewhere else.  They live on the trigger rather than `document` so
    // the non-passive touchmove cannot slow scrolling for a second finger
    // elsewhere on the page.
    const { signal } = controller;
    trigger.addEventListener("touchmove", onTouchMove, {
      passive: false,
      signal,
    });
    trigger.addEventListener("pointermove", onPointerMove, { signal });
  };

  // The touch gesture's rules live in `reduceQuickReactionGesture`, which
  // is unit-tested without a browser; this only turns its effects into DOM
  // work.  The state is a plain variable because nothing renders from it:
  // the row's visibility is `open` and the highlight is `slideButton`.
  let gesture = INITIAL_GESTURE;

  const applyGestureEffect = (effect: QuickReactionGestureEffect) => {
    switch (effect) {
      case "armLongPress":
        longPressTimer = setTimeout(
          () => dispatchGesture({ type: "longPressElapsed" }),
          LONG_PRESS_DELAY,
        );
        return;
      case "cancelLongPress":
        clearTimeout(longPressTimer);
        return;
      case "openRow":
        // The row must track a held finger immediately.  Animating this path
        // would make the visual target lag behind the gesture.
        openRow(false);
        return;
      case "beginSlideTracking":
        if (gesture.pointerId != null) beginSlideSession(gesture.pointerId);
        return;
      case "endSlideTracking":
        endSlideSession();
        return;
      case "commitSlideTarget":
        slideButton()?.click();
        return;
      case "toggleRow":
        cancelTimers();
        if (open()) {
          setOpen(false);
        } else {
          openRow(true);
        }
        return;
    }
  };

  const dispatchGesture = (event: QuickReactionGestureEvent) => {
    const transition = reduceQuickReactionGesture(gesture, event);
    gesture = transition.state;
    for (const effect of transition.effects) applyGestureEffect(effect);
  };

  const scheduleOpen = () => {
    cancelTimers();
    hoverTimer = setTimeout(() => openRow(true), OPEN_DELAY);
  };
  const scheduleClose = () => {
    cancelTimers();
    hoverTimer = setTimeout(() => setOpen(false), CLOSE_DELAY);
  };

  createEffect(() => {
    if (!open()) {
      setRowPosition(null);
      return;
    }
    const updatePosition = () => {
      if (trigger == null || row == null || !trigger.isConnected) {
        setOpen(false);
        return;
      }
      setRowPosition(
        getViewportQuickBarPosition(
          trigger.getBoundingClientRect(),
          { width: row.offsetWidth, height: row.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
          6,
          VIEWPORT_MARGIN,
        ),
      );
    };
    // Runs before the browser paints the freshly inserted row, so the
    // entrance animation starts from the final position.
    updatePosition();
    // The focusout handler cannot dismiss on outside taps in iOS Safari
    // (nothing inside the wrapper holds focus there), hence the
    // pointer-based outside dismissal.
    createOutsideDismiss(() => wrapper, dismiss);
    createViewportReposition(updatePosition);
  });

  const reactionsByEmoji = createMemo(
    () => new Map(props.reactions.map((group) => [group.emoji, group])),
  );
  const groupFor = (emoji: string) => reactionsByEmoji().get(emoji);
  const userHasReacted = () =>
    props.viewerHasReacted ??
    props.reactions.some((group) => group.viewerHasReacted);

  // select-none plus no touch callout on the wrapper: the emojis are
  // selectable text glyphs, so long-pressing them (or the trigger) on iOS
  // otherwise starts text selection or the system callout/drag sheet
  // instead of reacting.  Both properties reach the fixed row too, since
  // it stays a DOM child of this wrapper.
  return (
    <div
      ref={wrapper}
      class="relative inline-flex select-none [-webkit-touch-callout:none]"
      onPointerEnter={(event) => {
        if (event.pointerType === "touch" || props.disabled) return;
        scheduleOpen();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "touch") return;
        scheduleClose();
      }}
      onFocusIn={(event) => {
        // Only keyboard focus should reveal the bar; mouse clicks focus
        // the trigger too, but hover handling already covers those.
        if (props.disabled) return;
        if (
          event.target instanceof HTMLElement &&
          event.target.matches(":focus-visible")
        ) {
          cancelTimers();
          // Keyboard navigation is intentionally instant: repeated keyboard
          // actions should never wait for decorative movement.
          openRow(false);
        }
      }}
      onFocusOut={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && wrapper?.contains(next)) return;
        dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open()) {
          event.preventDefault();
          event.stopPropagation();
          // Move focus before unmounting a focused reaction button.  Focusing
          // inside the wrapper first also prevents focusout from dismissing a
          // second time or dropping focus onto the document body.
          trigger?.focus();
          dismiss();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        class="inline-flex h-8 touch-manipulation cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-2 text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11 [@media(pointer:coarse)]:px-3"
        classList={{
          "text-muted-foreground hover:text-foreground": !userHasReacted(),
          "text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300":
            userHasReacted(),
        }}
        disabled={props.disabled}
        aria-label={t`React`}
        title={t`React`}
        aria-expanded={open()}
        aria-controls={open() ? rowId : undefined}
        onPointerDown={(event) =>
          dispatchGesture({
            type: "pointerDown",
            pointerType: event.pointerType,
            pointerId: event.pointerId,
            disabled: props.disabled === true,
          })
        }
        onPointerUp={(event) =>
          dispatchGesture({ type: "pointerUp", pointerId: event.pointerId })
        }
        onPointerCancel={(event) =>
          dispatchGesture({ type: "pointerCancel", pointerId: event.pointerId })
        }
        // Tap and keyboard fallback; on mouse this closes the bar that
        // hover already opened, which reads as a toggle.  The gesture
        // machine drops the click a press-and-hold synthesizes.
        onClick={() => dispatchGesture({ type: "click" })}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill={userHasReacted() ? "currentColor" : "none"}
          viewBox="0 0 24 24"
          stroke-width="1.5"
          stroke="currentColor"
          class="size-4"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z"
          />
        </svg>
      </button>
      <Show when={open()}>
        {/* transition-none is load-bearing: duration/ease utilities also set
            transition timing, and a transition would animate the JS-assigned
            left/top from (0,0).  Only the container enters, keeping the seven
            controls available immediately instead of replaying a stagger. */}
        <div
          ref={row}
          id={rowId}
          role="group"
          aria-label={t`Quick reactions`}
          class="fixed z-50 flex items-center gap-0.5 rounded-full border bg-popover p-1 shadow-sm transition-none [@media(pointer:coarse)]:gap-0 [@media(pointer:coarse)]:p-px"
          classList={{
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.19,1,0.22,1)] motion-reduce:animate-in motion-reduce:fade-in-0 motion-reduce:duration-150 motion-reduce:ease-[cubic-bezier(0.25,0.46,0.45,0.94)]":
              animateEntrance(),
          }}
          style={{
            left: `${rowPosition()?.left ?? 0}px`,
            top: `${rowPosition()?.top ?? 0}px`,
            "transform-origin": rowPosition()?.transformOrigin,
            visibility: rowPosition() == null ? "hidden" : undefined,
          }}
        >
          <For each={REACTION_EMOJIS}>
            {(emoji) => {
              const group = () => groupFor(emoji);
              const selected = () => group()?.viewerHasReacted === true;
              const count = () => group()?.count ?? 0;
              const pending = () => props.pendingEmoji === emoji;
              return (
                <button
                  type="button"
                  class="group relative flex size-9 shrink-0 touch-manipulation cursor-pointer items-center justify-center rounded-full transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:size-11"
                  data-slide-target={emoji}
                  data-slide-active={slideActive(emoji)}
                  classList={{
                    "bg-red-50 ring-1 ring-red-300 dark:bg-red-950/40 dark:ring-red-800":
                      selected(),
                    "hover:bg-accent data-[slide-active]:bg-accent":
                      !selected(),
                  }}
                  aria-pressed={selected()}
                  aria-label={
                    selected()
                      ? t`Remove ${emoji} reaction`
                      : t`React with ${emoji}`
                  }
                  title={
                    selected()
                      ? t`Remove ${emoji} reaction`
                      : t`React with ${emoji}`
                  }
                  onClick={() => props.onToggleReaction(emoji)}
                >
                  <span
                    class="text-xl"
                    classList={{ "opacity-30": pending() }}
                    aria-hidden="true"
                  >
                    {emoji}
                  </span>
                  <Show when={pending()}>
                    <span class="absolute inset-0 flex items-center justify-center">
                      <IconLoader2
                        class="size-4 motion-safe:animate-spin"
                        aria-hidden="true"
                      />
                    </span>
                  </Show>
                  <Show when={count() > 0}>
                    <span class="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-muted px-1 text-center text-[10px] font-medium leading-4 text-muted-foreground tabular-nums">
                      {count()}
                    </span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
