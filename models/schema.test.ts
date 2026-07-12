import assert from "node:assert";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { postTable } from "./schema.ts";

test("postTable indexes actor outbox pagination", () => {
  const index = getTableConfig(postTable).indexes.find(
    (index) => index.config.name === "idx_post_outbox_actor_id_id",
  );

  assert.ok(index);
  assert.equal(index.config.columns.length, 2);
  assert.ok("name" in index.config.columns[0]);
  assert.equal(index.config.columns[0].name, "actor_id");
  assert.ok(index.config.where);
});
