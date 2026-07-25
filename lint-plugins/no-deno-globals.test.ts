import assert from "node:assert";
import test from "node:test";
import { lintWithOxlint } from "./test-helper.ts";

const RULE = "hackerspub-runtime/no-deno-globals";

function lint(source: string) {
  return lintWithOxlint(RULE, source);
}

test("flags a Deno namespace call", () => {
  const diagnostics = lint(`
    const dsn = Deno.env.get("SENTRY_DSN");
    export default dsn;
  `);
  assert.deepEqual(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].id, RULE);
});

test("flags every Deno reference in a file", () => {
  const diagnostics = lint(`
    export function shutdown() {
      Deno.addSignalListener("SIGTERM", () => Deno.exit(0));
    }
  `);
  assert.deepEqual(diagnostics.length, 2);
});

test("flags Deno reached through the global object", () => {
  const diagnostics = lint(`
    export const pid = globalThis.Deno.pid;
  `);
  assert.deepEqual(diagnostics.length, 1);
});

test("flags Deno behind a cast or non-null assertion on the global object", () => {
  for (const object of [
    "(globalThis as { Deno: { pid: number } })",
    "globalThis!",
    "(globalThis)",
  ]) {
    const diagnostics = lint(`
      export const pid = ${object}.Deno.pid;
    `);
    assert.deepEqual(diagnostics.length, 1, object);
  }
});

test("flags Deno in a type position", () => {
  const diagnostics = lint(`
    export declare const children: Deno.ChildProcess[];
  `);
  assert.deepEqual(diagnostics.length, 1);
});

test("flags a bare Deno reference", () => {
  const diagnostics = lint(`
    export const isDeno = typeof Deno !== "undefined";
  `);
  assert.deepEqual(diagnostics.length, 1);
});

test("flags a shorthand property reading the global", () => {
  const diagnostics = lint(`
    export const runtimes = { Deno };
  `);
  assert.deepEqual(diagnostics.length, 1);
});

test('does NOT flag the string "Deno"', () => {
  const diagnostics = lint(`
    export const runtime = "Deno";
    export const detected = "Deno" in globalThis;
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag an unrelated property named Deno", () => {
  const diagnostics = lint(`
    declare const runtimes: { Deno: string; Node: string };
    export const label = runtimes.Deno;
    export const table = { Deno: 1, Node: 2 };
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag a locally bound Deno", () => {
  const diagnostics = lint(`
    const Deno = { exit(code: number) { return code; } };
    export const result = Deno.exit(0);
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag an imported Deno binding", () => {
  const diagnostics = lint(`
    import { Deno } from "./shim.ts";
    export const result = Deno.exit(0);
  `);
  assert.deepEqual(diagnostics.length, 0);
});

// Without an import or export the fixture is a script, so its top-level
// binding lands in the global scope rather than a module scope.
test("does NOT flag a script's top-level Deno binding", () => {
  const diagnostics = lint(`
    const Deno = { exit(code: number) { return code; } };
    Deno.exit(0);
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag a Deno parameter", () => {
  const diagnostics = lint(`
    export function run(Deno: { exit(code: number): number }) {
      return Deno.exit(0);
    }
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag a destructured Deno binding", () => {
  const diagnostics = lint(`
    declare const shim: { Deno: { exit(code: number): number } };
    const { Deno } = shim;
    export const result = Deno.exit(0);
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag a Deno binding declared after its use", () => {
  const diagnostics = lint(`
    export function run() {
      return Deno.exit(0);
    }
    function Deno() {
      return { exit: (code: number) => code };
    }
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("does NOT flag a shadowed globalThis", () => {
  const diagnostics = lint(`
    declare const fake: { Deno: { pid: number } };
    export function probe() {
      const globalThis = fake;
      return globalThis.Deno.pid;
    }
  `);
  assert.deepEqual(diagnostics.length, 0);
});

test("still flags a global Deno alongside a nested shadowing binding", () => {
  const diagnostics = lint(`
    export const dsn = Deno.env.get("SENTRY_DSN");
    export function shim() {
      const Deno = { exit: (code: number) => code };
      return Deno.exit(0);
    }
  `);
  assert.deepEqual(diagnostics.length, 1);
});

test("does NOT flag ordinary Node.js code", () => {
  const diagnostics = lint(`
    import process from "node:process";
    export const dsn = process.env.SENTRY_DSN;
    export function fail() {
      process.exitCode = 1;
    }
  `);
  assert.deepEqual(diagnostics.length, 0);
});
