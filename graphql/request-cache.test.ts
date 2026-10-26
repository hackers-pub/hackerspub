import assert from "node:assert/strict";
import test from "node:test";
import { Kind, parse } from "graphql";
import type { UserContext } from "./builder.ts";
import { createRequestCache } from "./request-cache.ts";

test("request caches isolate operations even with the same context and database", () => {
  const ctx = { db: {} } as UserContext;
  const operations = parse(
    "query First { __typename } query Second { __typename }",
  ).definitions.filter((node) => node.kind === Kind.OPERATION_DEFINITION);
  let revision = "old";
  const cache = createRequestCache(() => ({ revision }));
  const first = cache(ctx, { operation: operations[0] });
  revision = "new";
  assert.equal(cache(ctx, { operation: operations[0] }), first);
  assert.deepEqual(cache(ctx, { operation: operations[1] }), {
    revision: "new",
  });
});
