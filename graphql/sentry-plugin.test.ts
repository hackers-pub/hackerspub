import assert from "node:assert/strict";
import test from "node:test";
import { PothosValidationError } from "@pothos/core";
import { decodeGlobalID } from "@pothos/plugin-relay";
import { ForbiddenError } from "@pothos/plugin-scope-auth";
import { GraphQLError } from "graphql";
import { createSchema, createYoga, type Plugin } from "graphql-yoga";
import { type SentryPluginClient, useSentry } from "./sentry-plugin.ts";

const executionFailures = [
  {
    label: "unexpected",
    error: new Error("private transaction failure"),
    report: true,
  },
  {
    label: "expected GraphQL",
    error: new GraphQLError("expected execution error"),
    report: false,
  },
  {
    label: "forbidden",
    error: new ForbiddenError("not authorized"),
    report: false,
  },
  {
    label: "validation",
    error: new PothosValidationError("invalid input"),
    report: false,
  },
  {
    label: "wrapped unexpected",
    error: new GraphQLError("wrapped failure", {
      originalError: new Error("private wrapped transaction failure"),
    }),
    report: true,
  },
  {
    label: "wrapped forbidden",
    error: new GraphQLError("wrapped authorization failure", {
      originalError: new ForbiddenError("not authorized"),
    }),
    report: false,
  },
  {
    label: "wrapped validation",
    error: new GraphQLError("wrapped validation failure", {
      originalError: new PothosValidationError("invalid input"),
    }),
    report: false,
  },
];

for (const { label, error: expected, report } of executionFailures) {
  for (const asynchronous of [false, true]) {
    test(`the Sentry plugin handles ${asynchronous ? "rejected" : "thrown"} ${label} execution wrapper failures`, async () => {
      const captured: Array<{ error: unknown; hint: unknown }> = [];
      const extras: unknown[] = [];
      let ended = 0;
      const client: SentryPluginClient = {
        startSpanManual(_options, callback) {
          return callback({
            setAttribute() {},
            end() {
              ended++;
            },
          });
        },
        withActiveSpan(_span, callback) {
          return callback();
        },
        withScope(callback) {
          return callback({
            setTransactionName() {},
            setTag() {},
            setExtra(name, value) {
              extras.push({ name, value });
            },
            addBreadcrumb() {},
          });
        },
        captureException(error, hint) {
          captured.push({ error, hint });
          return "wrapper-event-id";
        },
      };
      const failingWrapper: Plugin = {
        onExecute({ setExecuteFn }) {
          setExecuteFn(() => {
            if (asynchronous) return Promise.reject(expected);
            throw expected;
          });
        },
      };
      const yoga = createYoga({
        logging: false,
        plugins: [failingWrapper, useSentry(client)],
        schema: createSchema({
          typeDefs: "type Query { value(secretToken: String): String }",
          resolvers: { Query: { value: () => "unused" } },
        }),
      });
      try {
        const response = await yoga.fetch("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query:
              "query Timeline($secretToken: String!) { value(secretToken: $secretToken) }",
            operationName: "Timeline",
            variables: { secretToken: "must-not-reach-sentry" },
          }),
        });
        const result = await response.json();
        if (report) {
          assert.equal(response.status, 500);
          assert.deepEqual(result, {
            errors: [
              {
                message: "Unexpected error.",
                extensions: { code: "INTERNAL_SERVER_ERROR" },
              },
            ],
          });
          assert.equal(captured.length, 1);
          assert.strictEqual(
            captured[0]?.error,
            expected instanceof GraphQLError
              ? expected.originalError
              : expected,
          );
          assert.deepEqual(captured[0]?.hint, {
            fingerprint: ["graphql", "$execute", "Timeline", "query"],
            contexts: {
              GraphQL: { operationName: "Timeline", operationType: "query" },
            },
          });
        } else {
          assert.equal(captured.length, 0);
        }
        assert(
          !JSON.stringify({ captured, extras }).includes(
            "must-not-reach-sentry",
          ),
        );
        assert.equal(ended, 1);
      } finally {
        await yoga.dispose();
      }
    });
  }
}

for (const failureStage of ["scope", "capture"]) {
  test(`the Sentry plugin preserves execution errors when ${failureStage} fails`, async () => {
    const expected = new Error("original transaction failure");
    const sdkError = new Error("reporting failure");
    const observed: unknown[] = [];
    let ended = 0;
    const client: SentryPluginClient = {
      startSpanManual(_options, callback) {
        return callback({
          setAttribute() {},
          end() {
            ended++;
          },
        });
      },
      withActiveSpan(_span, callback) {
        return callback();
      },
      withScope(callback) {
        if (failureStage === "scope") throw sdkError;
        return callback({
          setTransactionName() {},
          setTag() {},
          setExtra() {},
          addBreadcrumb() {},
        });
      },
      captureException() {
        throw sdkError;
      },
    };
    const failingWrapper: Plugin = {
      onExecute({ setExecuteFn }) {
        setExecuteFn(async () => {
          throw expected;
        });
      },
    };
    const observingWrapper: Plugin = {
      onExecute({ executeFn, setExecuteFn }) {
        setExecuteFn(async (args) => {
          try {
            return await executeFn(args);
          } catch (error) {
            observed.push(error);
            throw error;
          }
        });
      },
    };
    const yoga = createYoga({
      logging: false,
      plugins: [failingWrapper, useSentry(client), observingWrapper],
      schema: createSchema({ typeDefs: "type Query { value: String }" }),
    });
    try {
      const response = await yoga.fetch("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ value }" }),
      });
      assert.equal(response.status, 500);
      assert.deepEqual(observed, [expected]);
      assert.strictEqual(observed[0], expected);
      assert.equal(ended, 1);
    } finally {
      await yoga.dispose();
    }
  });
}

test("the runtime-neutral Sentry plugin captures resolver failures", async () => {
  const captured: Array<{ error: unknown; hint: unknown }> = [];
  const ended: boolean[] = [];
  const expected = new Error("private resolver detail");
  const client: SentryPluginClient = {
    startSpanManual(_options, callback) {
      return callback({
        setAttribute() {},
        end() {
          ended.push(true);
        },
      });
    },
    withActiveSpan(_span, callback) {
      return callback();
    },
    withScope(callback) {
      return callback({
        setTransactionName() {},
        setTag() {},
        setExtra() {},
        addBreadcrumb() {},
      });
    },
    captureException(error, hint) {
      captured.push({ error, hint });
      return "event-id";
    },
  };
  const yoga = createYoga({
    logging: false,
    maskedErrors: false,
    plugins: [useSentry(client)],
    schema: createSchema({
      typeDefs:
        "type Query { fails(secretToken: String): String, expected: String, forbidden: String, invalidId: String }",
      resolvers: {
        Query: {
          fails() {
            throw expected;
          },
          expected() {
            throw new GraphQLError("expected GraphQL error");
          },
          forbidden() {
            throw new ForbiddenError("Not authorized to resolve this field.");
          },
          invalidId() {
            return decodeGlobalID("1").id;
          },
        },
      },
    }),
  });

  try {
    const failedResponse = await yoga.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          "query ($secretToken: String!) { fails(secretToken: $secretToken) }",
        variables: { secretToken: "must-not-reach-sentry" },
      }),
    });
    const failed = (await failedResponse.json()) as {
      readonly errors: readonly [
        { readonly extensions: { readonly sentryEventId?: string } },
      ];
    };
    assert.equal(captured.length, 1);
    assert.strictEqual(captured[0]?.error, expected);
    assert.deepEqual(captured[0]?.hint, {
      fingerprint: ["graphql", "fails", "Anonymous Operation", "query"],
      contexts: {
        GraphQL: {
          operationName: "Anonymous Operation",
          operationType: "query",
        },
      },
    });
    assert(!JSON.stringify(captured).includes("must-not-reach-sentry"));
    assert.equal(failed.errors[0].extensions.sentryEventId, "event-id");

    await yoga.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ expected }" }),
    });
    assert.equal(captured.length, 1);

    const forbiddenResponse = await yoga.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ forbidden }" }),
    });
    const forbidden = (await forbiddenResponse.json()) as {
      readonly errors: readonly [
        { readonly extensions?: { readonly sentryEventId?: string } },
      ];
    };
    assert.equal(captured.length, 1);
    assert.equal(forbidden.errors[0].extensions?.sentryEventId, undefined);
    const invalidResponse = await yoga.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ invalidId }" }),
    });
    const invalid = (await invalidResponse.json()) as {
      readonly errors: readonly [
        {
          readonly message: string;
          readonly extensions?: { readonly sentryEventId?: string };
        },
      ];
    };
    assert.equal(invalid.errors[0].message, "Invalid global ID: 1");
    assert.equal(captured.length, 1);
    assert.equal(invalid.errors[0].extensions?.sentryEventId, undefined);
    assert.deepEqual(ended, [true, true, true, true]);
  } finally {
    await yoga.dispose();
  }
});

test("the Sentry plugin describes the selected GraphQL operation", async () => {
  const spans: unknown[] = [];
  const captured: Array<{ error: unknown; hint: unknown }> = [];
  const expected = new Error("selected resolver failure");
  const client: SentryPluginClient = {
    startSpanManual(options, callback) {
      spans.push(options);
      return callback({
        setAttribute() {},
        end() {},
      });
    },
    withActiveSpan(_span, callback) {
      return callback();
    },
    withScope(callback) {
      return callback({
        setTransactionName() {},
        setTag() {},
        setExtra() {},
        addBreadcrumb() {},
      });
    },
    captureException(error, hint) {
      captured.push({ error, hint });
      return "selected-event-id";
    },
  };
  const yoga = createYoga({
    logging: false,
    maskedErrors: false,
    plugins: [useSentry(client)],
    schema: createSchema({
      typeDefs: `
        type Query {
          ignored: String
        }

        type Mutation {
          fails: String
        }
      `,
      resolvers: {
        Query: {
          ignored: () => "ignored",
        },
        Mutation: {
          fails() {
            throw expected;
          },
        },
      },
    }),
  });

  try {
    await yoga.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `
          query Ignored {
            ignored
          }

          mutation Selected {
            fails
          }
        `,
        operationName: "Selected",
      }),
    });

    assert.deepEqual(spans, [
      {
        name: "Selected",
        op: "execute",
        attributes: {
          operationName: "Selected",
          operation: "mutation",
        },
        forceTransaction: false,
      },
    ]);
    assert.strictEqual(captured[0]?.error, expected);
    assert.deepEqual(captured[0]?.hint, {
      fingerprint: ["graphql", "fails", "Selected", "mutation"],
      contexts: {
        GraphQL: {
          operationName: "Selected",
          operationType: "mutation",
        },
      },
    });
  } finally {
    await yoga.dispose();
  }
});
