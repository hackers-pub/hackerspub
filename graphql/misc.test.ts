import assert from "node:assert/strict";
import test from "node:test";
import { execute, parse } from "graphql";
import { schema } from "./mod.ts";
import { makeGuestContext, withRollback } from "../test/postgres.ts";

const availableLocalesQuery = parse(`
  query AvailableLocales {
    availableLocales
  }
`);

function toPlainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

test("availableLocales returns the locale files exposed by the GraphQL layer", async () => {
  await withRollback(async (tx) => {
    const result = await execute({
      schema,
      document: availableLocalesQuery,
      contextValue: makeGuestContext(tx),
      onError: "NO_PROPAGATE",
    });

    assert.equal(result.errors, undefined);
    const locales = (toPlainJson(result.data) as {
      availableLocales: string[];
    }).availableLocales;

    assert.deepEqual(locales.sort(), ["en", "ja", "ko", "zh-CN", "zh-TW"]);
  });
});
