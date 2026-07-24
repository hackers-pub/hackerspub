import assert from "node:assert/strict";
import test from "node:test";
import { GraphQLError } from "graphql";
import { createSchema, createYoga } from "graphql-yoga";
import { type SentryPluginClient, useSentry } from "./sentry-plugin.ts";

test("the runtime-neutral Sentry plugin captures resolver failures", async () => {
  const captured: unknown[] = [];
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
    captureException(error) {
      captured.push(error);
      return "event-id";
    },
  };
  const yoga = createYoga({
    logging: false,
    maskedErrors: false,
    plugins: [useSentry(client)],
    schema: createSchema({
      typeDefs: "type Query { fails: String, expected: String }",
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
      body: JSON.stringify({ query: "{ fails }" }),
    });
    const failed = (await failedResponse.json()) as {
      readonly errors: readonly [
        { readonly extensions: { readonly sentryEventId?: string } },
      ];
    };
    assert.deepEqual(captured, [expected]);
    assert.equal(failed.errors[0].extensions.sentryEventId, "event-id");

    await yoga.fetch("http://localhost/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ expected }" }),
    });
    assert.deepEqual(captured, [expected]);
    assert.deepEqual(ended, [true, true]);
  } finally {
    await yoga.dispose();
  }
});
