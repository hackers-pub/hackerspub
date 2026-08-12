// The touch half of the quick reaction bar, as a pure state machine.
//
// Everything here is timing and bookkeeping that broke repeatedly against
// mobile browser behavior, and none of it can be exercised without a real
// touch screen once it is entangled with the DOM: the press-and-hold
// threshold, the pointer that stays in charge afterwards, the click the
// browser synthesizes when that press ends, and which release commits a
// reaction versus discards one.  Keeping it as a transition function lets
// `quickReactionGesture.test.ts` cover those rules with no browser at all,
// leaving `QuickReactionBar.tsx` with a thin adapter that only translates
// effects into DOM work.
//
// The phases:
//
//   idle     -- no touch on the trigger.
//   pressing -- a touch is down and the long-press timer is running.  A
//               release here is an ordinary tap, handled by the trigger's
//               click as before.
//   sliding  -- the threshold elapsed, so the row is open and the finger
//               that opened it now picks an emoji.  Releasing commits
//               whatever the finger is over.
//
// Pointer identity is tracked so a second finger cannot commit the first
// one's gesture.  Note the deliberate asymmetry inherited from the DOM
// behavior this replaces: while `pressing`, any release disarms the timer
// (the trigger's own handler never filtered), whereas while `sliding` only
// the pointer that started the slide is listened to.

/**
 * Press-and-hold threshold before the row opens under the finger.  The
 * touch analogue of hover intent: comfortably above a tap (~100-200 ms)
 * and below the system long-press (~500 ms), so the row wins the gesture
 * before the browser offers its own callout.
 */
export const LONG_PRESS_DELAY = 400;

export type QuickReactionPhase = "idle" | "pressing" | "sliding";

export interface QuickReactionGestureState {
  readonly phase: QuickReactionPhase;
  /** The pointer being tracked, or `null` while idle. */
  readonly pointerId: number | null;
  /**
   * Whether the next click is the one the browser synthesizes at the end of
   * a press-and-hold.  It has to be dropped: the trigger's click toggles the
   * row, so letting it through would close what the hold just opened.
   */
  readonly swallowNextClick: boolean;
}

export const INITIAL_GESTURE: QuickReactionGestureState = {
  phase: "idle",
  pointerId: null,
  swallowNextClick: false,
};

export type QuickReactionGestureEvent =
  | {
      readonly type: "pointerDown";
      readonly pointerType: string;
      readonly pointerId: number;
      readonly disabled: boolean;
    }
  | { readonly type: "longPressElapsed" }
  | { readonly type: "pointerUp"; readonly pointerId: number }
  | { readonly type: "pointerCancel"; readonly pointerId: number }
  | { readonly type: "dismiss" }
  | { readonly type: "click" };

/**
 * What the caller must do in the DOM, in the order given.
 *
 *  - `armLongPress` / `cancelLongPress`: start or clear the threshold timer,
 *    which reports back as `longPressElapsed`.
 *  - `openRow`: show the row (it stays open after the finger lifts).
 *  - `beginSlideTracking` / `endSlideTracking`: attach or drop the listeners
 *    that suppress panning and follow the finger across the row.
 *  - `commitSlideTarget`: activate whatever the finger ended over, if
 *    anything.  Emitted before `endSlideTracking` so the tracked target is
 *    still available.
 *  - `toggleRow`: the ordinary tap/keyboard toggle.
 */
export type QuickReactionGestureEffect =
  | "armLongPress"
  | "cancelLongPress"
  | "openRow"
  | "beginSlideTracking"
  | "endSlideTracking"
  | "commitSlideTarget"
  | "toggleRow";

export interface QuickReactionGestureTransition {
  readonly state: QuickReactionGestureState;
  readonly effects: readonly QuickReactionGestureEffect[];
}

function unchanged(
  state: QuickReactionGestureState,
): QuickReactionGestureTransition {
  return { state, effects: [] };
}

export function reduceQuickReactionGesture(
  state: QuickReactionGestureState,
  event: QuickReactionGestureEvent,
): QuickReactionGestureTransition {
  switch (event.type) {
    case "pointerDown": {
      // Any press clears a pending swallow: whatever hold it belonged to is
      // over, and the click it was waiting for never arrived.
      if (event.pointerType !== "touch" || event.disabled) {
        // Mouse and pen open the row by hover and focus instead, and a
        // disabled trigger does nothing, but neither leaves a stale swallow
        // behind.
        return {
          state: { ...state, swallowNextClick: false },
          effects: [],
        };
      }
      // A fresh touch supersedes whatever the previous one was doing,
      // including a slide still in progress, which ends without committing.
      const effects: QuickReactionGestureEffect[] =
        state.phase === "sliding"
          ? ["endSlideTracking", "cancelLongPress", "armLongPress"]
          : ["cancelLongPress", "armLongPress"];
      return {
        state: {
          phase: "pressing",
          pointerId: event.pointerId,
          swallowNextClick: false,
        },
        effects,
      };
    }

    case "longPressElapsed": {
      // Only a live press can mature; anything else means the timer outlived
      // the gesture that armed it.
      if (state.phase !== "pressing") return unchanged(state);
      return {
        state: { ...state, phase: "sliding", swallowNextClick: true },
        effects: ["openRow", "beginSlideTracking"],
      };
    }

    case "pointerUp":
    case "pointerCancel": {
      if (state.phase === "pressing") {
        return {
          state: { ...state, phase: "idle", pointerId: null },
          effects: ["cancelLongPress"],
        };
      }
      if (state.phase !== "sliding") return unchanged(state);
      if (state.pointerId !== event.pointerId) return unchanged(state);
      return {
        state: { ...state, phase: "idle", pointerId: null },
        effects:
          event.type === "pointerUp"
            ? ["commitSlideTarget", "endSlideTracking"]
            : ["endSlideTracking"],
      };
    }

    case "dismiss": {
      return {
        state: {
          phase: "idle",
          pointerId: null,
          // A dismissed long press can still produce a synthesized click when
          // its original finger lifts.  Preserve the swallow so that click
          // cannot reopen the row that dismissal just closed.
          swallowNextClick: state.swallowNextClick,
        },
        effects:
          state.phase === "sliding"
            ? ["cancelLongPress", "endSlideTracking"]
            : ["cancelLongPress"],
      };
    }

    case "click": {
      if (state.swallowNextClick) {
        return { state: { ...state, swallowNextClick: false }, effects: [] };
      }
      return { state, effects: ["toggleRow"] };
    }
  }
}
