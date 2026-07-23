import assert from "node:assert";
import test from "node:test";
import {
  buildDenoImports,
  renderDenoConfig,
  toDenoImport,
  validateCatalog,
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

test("validateCatalog() rejects values that are not mappings", () => {
  assert.doesNotThrow(() => validateCatalog({ graphql: "^16.0.0" }));
  for (const value of [undefined, null, [], "graphql"]) {
    assert.throws(
      () => validateCatalog(value),
      /must define a catalog mapping/,
    );
  }
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
