import assert from "node:assert";
import test from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { compileQuery } from "./search-query.ts";
import { postTable } from "./schema.ts";

test("hashtag search materializes the selective GIN lookup", () => {
  const filter = compileQuery({ type: "hashtag", hashtag: "Fediverse" });
  const raw = filter.RAW;
  assert.ok(typeof raw === "function");

  const query = new PgDialect().sqlToQuery(raw(postTable, {} as never));
  assert.match(query.sql, /WITH "hashtag_candidates" AS MATERIALIZED/);
  assert.match(query.sql, /"tags" \? \$1/);
  assert.deepEqual(query.params, ["fediverse"]);
});
