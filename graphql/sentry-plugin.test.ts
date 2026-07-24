import assert from "node:assert/strict";
import test from "node:test";
import { GraphQLError } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import { type SentryPluginClient, useSentry } from "./sentry-plugin.ts";

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
        "type Query { fails(secretToken: String): String, expected: String }",
      resolvers: {
        Query: {
          fails() {
            throw expected;
          },
          expected() {
            throw new GraphQLError("expected GraphQL error");
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
    assert.deepEqual(ended, [true, true]);
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
