import assert from "node:assert";
import test from "node:test";
import { lintWithOxlint } from "./test-helper.ts";

const RULE = "hackerspub-tailwind/require-transition-property";

function lint(source: string) {
  return lintWithOxlint(RULE, source);
}

test("flags a duration utility with no transition property", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="rounded-full duration-300">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("flags an ease utility with no transition property", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="rounded-full ease-out">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 1);
});

// The regression this rule exists for: entrance-animation timing on a button
// that also has a hover background.
test("flags variant-prefixed timing beside an arbitrary bezier", () => {
  const diagnostics = lint(`
    export const React = () => (
      <button
        type="button"
        class="rounded-full hover:bg-accent motion-safe:animate-in motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.34,1.56,0.64,1)]"
      >
        x
      </button>
    );
  `);
  assert.deepEqual(diagnostics.length, 1);
});

test("flags each offending element separately", () => {
  const diagnostics = lint(`
    export const Row = () => (
      <div>
        <span class="duration-200">a</span>
        <span class="ease-in">b</span>
      </div>
    );
  `);
  assert.deepEqual(diagnostics.length, 2);
});

test("flags timing declared through classList", () => {
  const diagnostics = lint(`
    export const Badge = (props: { active: boolean }) => (
      <span class="rounded-full" classList={{ "duration-300": props.active }}>
        1
      </span>
    );
  `);
  assert.deepEqual(diagnostics.length, 1);
});

test("does NOT flag timing paired with transition-none", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="rounded-full transition-none duration-300">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag timing paired with a property list", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="transition-colors duration-150 ease-out">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag the bare transition utility", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="transition duration-150">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag an arbitrary transition property", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="transition-[width,height] duration-150">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

// The property declaration may live in either class source, so both are read
// before deciding.
test("does NOT flag when classList supplies the transition property", () => {
  const diagnostics = lint(`
    export const Badge = (props: { active: boolean }) => (
      <span
        class="rounded-full duration-300"
        classList={{ "transition-transform": props.active }}
      >
        1
      </span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag a variant-prefixed transition property", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="motion-safe:transition-none motion-safe:duration-300">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

// `transition-behavior`, not `transition-property`: it leaves the initial
// `all` in place, so it must not satisfy the rule.
test("flags transition-discrete standing in for a property list", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="transition-discrete duration-300">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 1);
});

test("does NOT flag an element without timing utilities", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="rounded-full bg-accent hover:bg-muted">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

// A colon inside brackets belongs to the value, not to a variant prefix.
test("does NOT mistake a bracketed colon for a variant separator", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="[&:hover]:transition-none [&:hover]:duration-300">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag utilities that merely start like a timing one", () => {
  const diagnostics = lint(`
    export const Badge = () => (
      <span class="durations easement">1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

// Everything below is unreadable statically, so the rule stays quiet rather
// than guessing: the class it asks for could be in the part it cannot see.
test("does NOT flag a class expression it cannot read", () => {
  const diagnostics = lint(`
    declare const classes: string;
    export const Badge = () => <span class={classes}>1</span>;
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag an interpolated class template", () => {
  const diagnostics = lint(`
    declare const extra: string;
    export const Badge = () => (
      <span class={\`duration-300 \${extra}\`}>1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag an element with a spread attribute", () => {
  const diagnostics = lint(`
    declare const rest: Record<string, unknown>;
    export const Badge = () => <span class="duration-300" {...rest}>1</span>;
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag a spread inside classList", () => {
  const diagnostics = lint(`
    declare const extra: Record<string, boolean>;
    export const Badge = () => (
      <span class="duration-300" classList={{ ...extra }}>1</span>
    );
  `);
  assert.deepEqual(diagnostics.length, 0);
});

// A static template literal is fully readable, so it is still checked.
test("flags a template class with no interpolation", () => {
  const diagnostics = lint(`
    export const Badge = () => <span class={\`duration-300\`}>1</span>;
  `);
  assert.deepEqual(diagnostics.length, 1);
});

test("does NOT offer an autofix", () => {
  const diagnostics = lint(`
    export const Badge = () => <span class="duration-300">1</span>;
  `);
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].fix, []);
});
