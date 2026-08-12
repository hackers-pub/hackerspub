import assert from "node:assert";
import test from "node:test";
import {
  INITIAL_GESTURE,
  type QuickReactionGestureEffect,
  type QuickReactionGestureEvent,
  type QuickReactionGestureState,
  reduceQuickReactionGesture,
} from "./quickReactionGesture.ts";

/** Replays a sequence, returning the final state and the effects in order. */
function run(
  events: readonly QuickReactionGestureEvent[],
  from: QuickReactionGestureState = INITIAL_GESTURE,
): {
  state: QuickReactionGestureState;
  effects: QuickReactionGestureEffect[];
} {
  let state = from;
  const effects: QuickReactionGestureEffect[] = [];
  for (const event of events) {
    const transition = reduceQuickReactionGesture(state, event);
    state = transition.state;
    effects.push(...transition.effects);
  }
  return { state, effects };
}

const touchDown = (pointerId = 1): QuickReactionGestureEvent => ({
  type: "pointerDown",
  pointerType: "touch",
  pointerId,
  disabled: false,
});

test("a touch press arms the long-press timer", () => {
  const { state, effects } = run([touchDown()]);
  assert.deepEqual(effects, ["cancelLongPress", "armLongPress"]);
  assert.deepEqual(state.phase, "pressing");
  assert.deepEqual(state.pointerId, 1);
});

test("holding past the threshold opens the row and starts tracking", () => {
  const { state, effects } = run([touchDown(), { type: "longPressElapsed" }]);
  assert.deepEqual(effects, [
    "cancelLongPress",
    "armLongPress",
    "openRow",
    "beginSlideTracking",
  ]);
  assert.deepEqual(state.phase, "sliding");
});

test("releasing over a target commits it before tracking ends", () => {
  const { state, effects } = run([
    touchDown(),
    { type: "longPressElapsed" },
    { type: "pointerUp", pointerId: 1 },
  ]);
  assert.deepEqual(effects.slice(-2), [
    "commitSlideTarget",
    "endSlideTracking",
  ]);
  assert.deepEqual(state.phase, "idle");
  assert.deepEqual(state.pointerId, null);
});

// The browser takes the touch away when it decides the gesture is a scroll,
// which must never be read as choosing whatever sits under the finger.
test("a cancelled slide ends without committing", () => {
  const { state, effects } = run([
    touchDown(),
    { type: "longPressElapsed" },
    { type: "pointerCancel", pointerId: 1 },
  ]);
  assert.ok(!effects.includes("commitSlideTarget"));
  assert.deepEqual(effects.at(-1), "endSlideTracking");
  assert.deepEqual(state.phase, "idle");
});

test("dismissing a pending press disarms it", () => {
  const { state, effects } = run([
    touchDown(),
    { type: "dismiss" },
    { type: "longPressElapsed" },
  ]);
  assert.ok(!effects.includes("openRow"));
  assert.deepEqual(effects.at(-1), "cancelLongPress");
  assert.deepEqual(state, INITIAL_GESTURE);
});

test("dismissing a slide ends tracking without committing", () => {
  const { state, effects } = run([
    touchDown(),
    { type: "longPressElapsed" },
    { type: "dismiss" },
    { type: "pointerUp", pointerId: 1 },
  ]);
  assert.ok(!effects.includes("commitSlideTarget"));
  assert.deepEqual(effects.slice(-2), ["cancelLongPress", "endSlideTracking"]);
  assert.deepEqual(state.phase, "idle");
  assert.deepEqual(state.pointerId, null);
});

test("the synthesized click after a dismissed slide stays swallowed", () => {
  const { state, effects } = run([
    touchDown(),
    { type: "longPressElapsed" },
    { type: "dismiss" },
    { type: "pointerUp", pointerId: 1 },
    { type: "click" },
  ]);
  assert.ok(!effects.includes("toggleRow"));
  assert.deepEqual(state, INITIAL_GESTURE);
});

test("releasing before the threshold disarms the timer and commits nothing", () => {
  const { state, effects } = run([
    touchDown(),
    { type: "pointerUp", pointerId: 1 },
  ]);
  assert.deepEqual(effects, [
    "cancelLongPress",
    "armLongPress",
    "cancelLongPress",
  ]);
  assert.ok(!effects.includes("openRow"));
  assert.deepEqual(state.phase, "idle");
});

// The tap path: the trigger's click toggles the row, and a press that never
// matured must not interfere with it.
test("a short tap still toggles the row", () => {
  const { effects } = run([
    touchDown(),
    { type: "pointerUp", pointerId: 1 },
    { type: "click" },
  ]);
  assert.deepEqual(effects.at(-1), "toggleRow");
});

test("the click synthesized after a hold is swallowed", () => {
  const { state, effects } = run([
    touchDown(),
    { type: "longPressElapsed" },
    { type: "pointerUp", pointerId: 1 },
    { type: "click" },
  ]);
  assert.ok(!effects.includes("toggleRow"));
  assert.deepEqual(state.swallowNextClick, false);
});

test("only one click is swallowed per hold", () => {
  const { effects } = run([
    touchDown(),
    { type: "longPressElapsed" },
    { type: "pointerUp", pointerId: 1 },
    { type: "click" },
    { type: "click" },
  ]);
  assert.deepEqual(
    effects.filter((effect) => effect === "toggleRow").length,
    1,
  );
});

// A hold whose synthesized click never arrives (browsers suppress it once
// the finger has travelled) must not leave the next tap swallowed.
test("a new press clears a swallow the browser never spent", () => {
  const { state } = run([
    touchDown(),
    { type: "longPressElapsed" },
    { type: "pointerUp", pointerId: 1 },
    touchDown(2),
  ]);
  assert.deepEqual(state.swallowNextClick, false);
});

test("a mouse press clears a pending swallow without arming anything", () => {
  const { state, effects } = run([
    {
      type: "pointerDown",
      pointerType: "mouse",
      pointerId: 7,
      disabled: false,
    },
  ]);
  assert.deepEqual(effects, []);
  assert.deepEqual(state.phase, "idle");
  assert.deepEqual(state.swallowNextClick, false);
});

test("a pen press does not start a hold", () => {
  const { state, effects } = run([
    { type: "pointerDown", pointerType: "pen", pointerId: 3, disabled: false },
  ]);
  assert.deepEqual(effects, []);
  assert.deepEqual(state.phase, "idle");
});

test("a disabled trigger does not start a hold", () => {
  const { state, effects } = run([
    { type: "pointerDown", pointerType: "touch", pointerId: 1, disabled: true },
  ]);
  assert.deepEqual(effects, []);
  assert.deepEqual(state.phase, "idle");
});

// Pointer identity: a second finger elsewhere must not commit the slide the
// first one is driving.
test("another pointer's release does not commit the slide", () => {
  const { state, effects } = run([
    touchDown(1),
    { type: "longPressElapsed" },
    { type: "pointerUp", pointerId: 2 },
  ]);
  assert.ok(!effects.includes("commitSlideTarget"));
  assert.deepEqual(state.phase, "sliding");
  assert.deepEqual(state.pointerId, 1);
});

test("another pointer's cancel does not end the slide", () => {
  const { state, effects } = run([
    touchDown(1),
    { type: "longPressElapsed" },
    { type: "pointerCancel", pointerId: 2 },
  ]);
  assert.ok(!effects.includes("endSlideTracking"));
  assert.deepEqual(state.phase, "sliding");
});

test("a second touch replaces a slide in progress without committing", () => {
  const { state, effects } = run([
    touchDown(1),
    { type: "longPressElapsed" },
    touchDown(2),
  ]);
  assert.ok(!effects.includes("commitSlideTarget"));
  assert.deepEqual(effects.slice(-3), [
    "endSlideTracking",
    "cancelLongPress",
    "armLongPress",
  ]);
  assert.deepEqual(state.phase, "pressing");
  assert.deepEqual(state.pointerId, 2);
});

test("a second touch re-arms the timer for the newer pointer", () => {
  const { state } = run([touchDown(1), touchDown(2)]);
  assert.deepEqual(state.phase, "pressing");
  assert.deepEqual(state.pointerId, 2);
});

// A timer that outlives the gesture that armed it must do nothing, so a
// missed cancellation cannot open the row after the finger is gone.
test("a stale threshold does not open the row", () => {
  const { state, effects } = run([
    touchDown(),
    { type: "pointerUp", pointerId: 1 },
    { type: "longPressElapsed" },
  ]);
  assert.ok(!effects.includes("openRow"));
  assert.deepEqual(state.phase, "idle");
});

test("releases outside a gesture do nothing", () => {
  const { state, effects } = run([
    { type: "pointerUp", pointerId: 1 },
    { type: "pointerCancel", pointerId: 1 },
  ]);
  assert.deepEqual(effects, []);
  assert.deepEqual(state, INITIAL_GESTURE);
});

test("a click with no gesture in flight toggles the row", () => {
  const { effects } = run([{ type: "click" }]);
  assert.deepEqual(effects, ["toggleRow"]);
});

test("the reducer does not mutate the state it is given", () => {
  const before = { ...INITIAL_GESTURE };
  reduceQuickReactionGesture(INITIAL_GESTURE, touchDown());
  assert.deepEqual(INITIAL_GESTURE, before);
});

// Two full holds in a row: the second must behave exactly like the first.
test("consecutive holds each open, commit, and swallow once", () => {
  const sequence: QuickReactionGestureEvent[] = [
    touchDown(1),
    { type: "longPressElapsed" },
    { type: "pointerUp", pointerId: 1 },
    { type: "click" },
    touchDown(2),
    { type: "longPressElapsed" },
    { type: "pointerUp", pointerId: 2 },
    { type: "click" },
  ];
  const { state, effects } = run(sequence);
  assert.deepEqual(effects.filter((effect) => effect === "openRow").length, 2);
  assert.deepEqual(
    effects.filter((effect) => effect === "commitSlideTarget").length,
    2,
  );
  assert.ok(!effects.includes("toggleRow"));
  assert.deepEqual(state, { ...INITIAL_GESTURE });
});
