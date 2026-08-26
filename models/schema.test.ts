import assert from "node:assert";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { actorTable, postTable } from "./schema.ts";

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

test("postTable indexes link preview and news boost lookups", () => {
  const indexes = getTableConfig(postTable).indexes;

  const linkUrlIndex = indexes.find(
    (index) => index.config.name === "idx_post_link_url_updated",
  );
  assert.ok(linkUrlIndex);
  assert.equal(linkUrlIndex.config.columns.length, 2);
  assert.ok("name" in linkUrlIndex.config.columns[0]);
  assert.equal(linkUrlIndex.config.columns[0].name, "link_url");
  assert.ok(linkUrlIndex.config.where);

  const newsBoostIndex = indexes.find(
    (index) => index.config.name === "idx_post_news_boost_updated",
  );
  assert.ok(newsBoostIndex);
  assert.equal(newsBoostIndex.config.columns.length, 1);
  assert.ok("name" in newsBoostIndex.config.columns[0]);
  assert.equal(newsBoostIndex.config.columns[0].name, "updated");
  assert.ok(newsBoostIndex.config.where);
});

test("actorTable indexes remote maintenance and identity lookups", () => {
  const indexes = getTableConfig(actorTable).indexes;

  const suspensionIndex = indexes.find(
    (index) => index.config.name === "idx_actor_remote_suspended_until",
  );
  assert.ok(suspensionIndex);
  assert.ok("name" in suspensionIndex.config.columns[0]);
  assert.equal(suspensionIndex.config.columns[0].name, "suspended_until");
  assert.ok(suspensionIndex.config.where);

  const urlIndex = indexes.find(
    (index) => index.config.name === "idx_actor_url",
  );
  assert.ok(urlIndex);
  assert.ok("name" in urlIndex.config.columns[0]);
  assert.equal(urlIndex.config.columns[0].name, "url");
  assert.ok(urlIndex.config.where);

  const aliasesIndex = indexes.find(
    (index) => index.config.name === "idx_actor_aliases_gin",
  );
  assert.ok(aliasesIndex);
  assert.equal(aliasesIndex.config.method, "gin");
  assert.ok("name" in aliasesIndex.config.columns[0]);
  assert.equal(aliasesIndex.config.columns[0].name, "aliases");
});
