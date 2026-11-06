import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  buildSchema,
  execute,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse,
} from "graphql";
import { runWithRequestWork } from "@hackerspub/models/request-work";
import { instrumentRequestWork } from "./request-work.ts";

test("request tracking drains promised list items, abstract types and late nested resolvers", async () => {
  const item = Promise.withResolvers<object>();
  const resolveType = Promise.withResolvers<string>();
  const isTypeOf = Promise.withResolvers<boolean>();
  const child = Promise.withResolvers<string>();
  const typeStarted = Promise.withResolvers<void>();
  const objectStarted = Promise.withResolvers<void>();
  const childStarted = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  let finished = false;
  const node = new GraphQLInterfaceType({
    name: "Node",
    fields: { child: { type: GraphQLString } },
    resolveType() {
      typeStarted.resolve();
      return resolveType.promise;
    },
  });
  const thing = new GraphQLObjectType({
    name: "Thing",
    interfaces: [node],
    isTypeOf() {
      objectStarted.resolve();
      return isTypeOf.promise;
    },
    fields: {
      child: {
        type: GraphQLString,
        resolve() {
          childStarted.resolve();
          return child.promise;
        },
      },
    },
  });
  const schema = instrumentRequestWork(
    new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          fail: {
            type: new GraphQLNonNull(GraphQLString),
            async resolve() {
              throw new Error("non-null sibling failure");
            },
          },
          nodes: { type: new GraphQLList(node), resolve: () => [item.promise] },
        },
      }),
      types: [thing],
    }),
  );
  const execution = runWithRequestWork(
    new AbortController().signal,
    async () => {
      const result = await execute({
        schema,
        document: parse("{ fail nodes { child } }"),
      });
      assert.equal(result.data, null);
      returned.resolve();
      return result;
    },
  ).then((result) => {
    finished = true;
    return result;
  });
  await returned.promise;
  await setImmediate();
  assert.equal(finished, false);
  item.resolve({});
  await typeStarted.promise;
  await setImmediate();
  assert.equal(finished, false);
  resolveType.resolve("Thing");
  await objectStarted.promise;
  isTypeOf.resolve(true);
  await childStarted.promise;
  await setImmediate();
  assert.equal(finished, false);
  child.resolve("done");
  await execution;
});

test("request tracking owns nested promised arrays after execution returns", async () => {
  const late = Promise.withResolvers<string>();
  const returned = Promise.withResolvers<void>();
  const schema = instrumentRequestWork(
    buildSchema("type Query { fail: String! matrix: [[String]] }"),
  );
  let finished = false;
  const execution = runWithRequestWork(
    new AbortController().signal,
    async () => {
      const result = await execute({
        schema,
        document: parse("{ fail matrix }"),
        rootValue: {
          fail: async () => {
            throw new Error("failed");
          },
          matrix: [Promise.resolve([late.promise])],
        },
      });
      returned.resolve();
      return result;
    },
  ).then(() => {
    finished = true;
  });
  await returned.promise;
  await setImmediate();
  assert.equal(finished, false);
  late.resolve("done");
  await execution;
});

test("synchronous non-null failure retains an already-started asynchronous sibling", async () => {
  const sibling = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  const schema = instrumentRequestWork(
    buildSchema("type Query { sibling: String fail: String! }"),
  );
  let finished = false;
  const request = runWithRequestWork(new AbortController().signal, async () =>
    execute({
      schema,
      document: parse("{ sibling fail }"),
      rootValue: {
        sibling: () => {
          started.resolve();
          return sibling.promise;
        },
        fail: () => {
          throw new Error("synchronous failure");
        },
      },
    }),
  ).then((result) => {
    finished = true;
    return result;
  });
  await started.promise;
  await setImmediate();
  assert.equal(finished, false);
  sibling.resolve("finished sibling");
  const result = await request;
  assert.equal(result.data, null);
  assert.equal(result.errors?.[0].message, "synchronous failure");
});

test("array items remain owned when an earlier non-null item fails synchronously", async () => {
  const late = Promise.withResolvers<string>();
  const returned = Promise.withResolvers<void>();
  const schema = instrumentRequestWork(
    buildSchema("type Query { values: [String!] }"),
  );
  let finished = false;
  const request = runWithRequestWork(new AbortController().signal, async () => {
    const result = await execute({
      schema,
      document: parse("{ values }"),
      rootValue: { values: [null, late.promise] },
    });
    assert.equal(result.data?.values, null);
    returned.resolve();
    return result;
  }).then(() => {
    finished = true;
  });
  await returned.promise;
  await setImmediate();
  assert.equal(finished, false);
  late.resolve("late item");
  await request;
});

test("request tracking cancels new nested resolvers while draining started work", async () => {
  const cancelled = new AbortController();
  const value = Promise.withResolvers<object>();
  const started = Promise.withResolvers<void>();
  let childCalls = 0;
  const child = new GraphQLObjectType({
    name: "Child",
    fields: {
      text: {
        type: GraphQLString,
        resolve: () => {
          childCalls++;
          return "text";
        },
      },
    },
  });
  const schema = instrumentRequestWork(
    new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          child: {
            type: child,
            resolve: () => {
              started.resolve();
              return value.promise;
            },
          },
        },
      }),
    }),
  );
  const execution = runWithRequestWork(cancelled.signal, async () =>
    execute({ schema, document: parse("{ child { text } }") }),
  );
  await started.promise;
  cancelled.abort();
  value.resolve({});
  const result = await execution;
  assert.equal(childCalls, 0);
  assert.ok(
    result.errors?.some((error) => error.originalError?.name === "AbortError"),
  );
});

for (const onError of ["PROPAGATE", "NO_PROPAGATE"] as const) {
  test(`request tracking preserves ${onError} result semantics and synchronous execution`, async () => {
    const schema = instrumentRequestWork(
      buildSchema("type Query { fail: String! other: String }"),
    );
    const input = {
      schema,
      document: parse("{ fail other }"),
      rootValue: {
        fail: () => {
          throw new Error("failed");
        },
        other: "other",
      },
      onError,
    };
    const expected = execute(input);
    assert.ok(!(expected instanceof Promise));
    const actual = await runWithRequestWork(
      new AbortController().signal,
      async () => {
        const result = execute(input);
        assert.ok(!(result instanceof Promise));
        return result;
      },
    );
    assert.deepEqual(actual.data, expected.data);
    assert.deepEqual(
      actual.errors?.map((error) => error.message),
      expected.errors?.map((error) => error.message),
    );
  });
}

test("request tracking consumes a one-shot list exactly once and remains idempotent", async () => {
  const schema = instrumentRequestWork(
    buildSchema("type Query { values: [String] }"),
  );
  assert.equal(instrumentRequestWork(schema), schema);
  let consumed = 0;
  function* values() {
    consumed++;
    yield "one";
    yield "two";
  }
  const list = values();
  await runWithRequestWork(new AbortController().signal, async () => {
    const result = execute({
      schema,
      document: parse("{ values }"),
      rootValue: { values: list },
    });
    assert.ok(!(result instanceof Promise));
    assert.deepEqual(result.data?.values, ["one", "two"]);
    assert.equal(consumed, 1);
    return result;
  });
});
