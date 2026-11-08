import assert from "node:assert";
import test, { type TestContext } from "node:test";
import {
  getInteractiveGraphQLTimeout,
  getSsrGraphQLPolicy,
} from "./graphQLTransportPolicy.ts";

const SETTINGS = [
  "WEB_SSR_GRAPHQL_TIMEOUT_MS",
  "WEB_SSR_GRAPHQL_BUDGET_MS",
  "WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS",
] as const;

function environment(
  t: TestContext,
  values: Partial<Record<(typeof SETTINGS)[number], string>> = {},
) {
  for (const name of SETTINGS) {
    const original = process.env[name];
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
}

test("GraphQL policy: absent settings use independent SSR and interactive defaults", (t) => {
  environment(t);
  assert.deepEqual(getSsrGraphQLPolicy(), {
    timeoutMs: 10_000,
    budgetMs: 15_000,
  });
  assert.equal(getInteractiveGraphQLTimeout(), 180_000);
});

test("GraphQL policy: explicit settings include supported timer boundaries", (t) => {
  environment(t, {
    WEB_SSR_GRAPHQL_TIMEOUT_MS: "1",
    WEB_SSR_GRAPHQL_BUDGET_MS: "2147483647",
    WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS: "120000",
  });
  assert.deepEqual(getSsrGraphQLPolicy(), {
    timeoutMs: 1,
    budgetMs: 2_147_483_647,
  });
  assert.equal(getInteractiveGraphQLTimeout(), 120_000);
});

for (const name of SETTINGS) {
  test(`GraphQL policy: ${name} rejects malformed or out-of-range explicit values`, (t) => {
    environment(t);
    for (const value of [
      "",
      " ",
      "\t10",
      "10 ",
      "0",
      "-1",
      "+1",
      "1.5",
      "1.0",
      "1e3",
      "0x10",
      "NaN",
      "Infinity",
      "2147483648",
      "9007199254740992",
    ]) {
      process.env[name] = value;
      const read =
        name === "WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS"
          ? getInteractiveGraphQLTimeout
          : getSsrGraphQLPolicy;
      assert.throws(
        read,
        (error) => error instanceof Error && error.message.includes(name),
        `${name}=${JSON.stringify(value)}`,
      );
    }
  });
}

test("GraphQL policy: interactive never reads invalid SSR settings", (t) => {
  environment(t, {
    WEB_SSR_GRAPHQL_TIMEOUT_MS: "",
    WEB_SSR_GRAPHQL_BUDGET_MS: "invalid",
    WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS: "25000",
  });
  assert.equal(getInteractiveGraphQLTimeout(), 25_000);
  assert.throws(getSsrGraphQLPolicy, /WEB_SSR_GRAPHQL_TIMEOUT_MS/);
});

test("GraphQL policy: SSR never reads invalid interactive settings", (t) => {
  environment(t, { WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS: "" });
  assert.deepEqual(getSsrGraphQLPolicy(), {
    timeoutMs: 10_000,
    budgetMs: 15_000,
  });
  assert.throws(
    getInteractiveGraphQLTimeout,
    /WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS/,
  );
});

test("GraphQL policy: values are read at runtime rather than cached at import", (t) => {
  environment(t);
  assert.equal(getInteractiveGraphQLTimeout(), 180_000);
  process.env.WEB_INTERACTIVE_GRAPHQL_TIMEOUT_MS = "90000";
  assert.equal(getInteractiveGraphQLTimeout(), 90_000);
});
