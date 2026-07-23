import assert from "node:assert";
import test from "node:test";
import {
  buildDenoImports,
  renderDenoConfig,
  toDenoImport,
} from "./sync-deno-imports.ts";

test("toDenoImport() expands npm and JSR catalog values", () => {
  assert.equal(toDenoImport("graphql", "^16.0.0"), "npm:graphql@^16.0.0");
  assert.equal(
    toDenoImport("@std/assert", "jsr:^1.0.0"),
    "jsr:@std/assert@^1.0.0",
  );
});

test("toDenoImport() preserves explicit registry aliases", () => {
  assert.equal(
    toDenoImport("@sentry/node", "npm:@sentry/core@^10.0.0"),
    "npm:@sentry/core@^10.0.0",
  );
  assert.equal(
    toDenoImport("@example/alias", "jsr:@example/original@^1.0.0"),
    "jsr:@example/original@^1.0.0",
  );
});

test("toDenoImport() maps pnpm-compatible JSR tarballs back to JSR", () => {
  assert.equal(
    toDenoImport(
      "@logtape/sentry",
      "https://npm.jsr.io/~/11/@jsr/logtape__sentry/" +
        "2.2.0-dev.620+455a47e2.tgz",
    ),
    "jsr:@logtape/sentry@2.2.0-dev.620+455a47e2",
  );
  assert.throws(
    () =>
      toDenoImport(
        "@logtape/logtape",
        "https://npm.jsr.io/~/11/@jsr/logtape__sentry/2.2.0.tgz",
      ),
    /cannot define/,
  );
});

test("buildDenoImports() sorts entries and rejects invalid values", () => {
  assert.deepEqual(
    buildDenoImports({
      zod: "^4.0.0",
      "@std/assert": "jsr:^1.0.0",
    }),
    {
      "@std/assert": "jsr:@std/assert@^1.0.0",
      zod: "npm:zod@^4.0.0",
    },
  );
  assert.throws(
    () => buildDenoImports({ graphql: null }),
    /must be a string/,
  );
});

test("renderDenoConfig() replaces imports without changing other fields", () => {
  const rendered = renderDenoConfig(
    '{\n  "workspace": ["graphql"],\n  "imports": {"old": "npm:old@1"}\n}\n',
    { graphql: "canary-pr-4364" },
  );
  assert.equal(
    rendered,
    "{\n" +
      '  "workspace": [\n' +
      '    "graphql"\n' +
      "  ],\n" +
      '  "imports": {\n' +
      '    "graphql": "npm:graphql@canary-pr-4364"\n' +
      "  }\n" +
      "}\n",
  );
});
