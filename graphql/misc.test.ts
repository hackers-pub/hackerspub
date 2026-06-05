import assert from "node:assert/strict";
import test from "node:test";
import { execute, parse } from "graphql";
import { eq } from "drizzle-orm";
import type { Locale } from "@hackerspub/models/i18n";
import { accountTable } from "@hackerspub/models/schema";
import { schema } from "./mod.ts";
import {
  insertAccountWithActor,
  makeGuestContext,
  makeUserContext,
  toPlainJson,
  withRollback,
} from "../test/postgres.ts";

const availableLocalesQuery = parse(`
  query AvailableLocales {
    availableLocales
  }
`);

const suggestedFilterLanguagesQuery = parse(`
  query SuggestedFilterLanguages {
    suggestedFilterLanguages
  }
`);

test(
  "suggestedFilterLanguages returns base codes from account locales when signed in",
  async () => {
    await withRollback(async (tx) => {
      const { account: rawAccount } = await insertAccountWithActor(tx, {
        username: "suggestedlangsuser",
        name: "Suggested Langs User",
        email: "suggestedlangsuser@example.com",
      });
      const locales = ["ko-KR", "en-US"] as Locale[];
      await tx.update(accountTable)
        .set({ locales })
        .where(eq(accountTable.id, rawAccount.id));
      const account = { ...rawAccount, locales };
      const ctx = makeUserContext(tx, account);
      const result = await execute({
        schema,
        document: suggestedFilterLanguagesQuery,
        contextValue: ctx,
      });
      assert.deepEqual(result.errors, undefined);
      assert.deepEqual(
        (result.data as { suggestedFilterLanguages: string[] })
          .suggestedFilterLanguages,
        ["ko", "en"],
      );
    });
  },
);

test(
  "suggestedFilterLanguages parses Accept-Language header for guests",
  async () => {
    await withRollback(async (tx) => {
      const ctx = makeGuestContext(tx, {
        request: new Request("http://localhost/graphql", {
          headers: { "accept-language": "fr-FR,en;q=0.9,ja;q=0.8" },
        }),
      });
      const result = await execute({
        schema,
        document: suggestedFilterLanguagesQuery,
        contextValue: ctx,
      });
      assert.deepEqual(result.errors, undefined);
      assert.deepEqual(
        (result.data as { suggestedFilterLanguages: string[] })
          .suggestedFilterLanguages,
        ["fr", "en", "ja"],
      );
    });
  },
);

test(
  "suggestedFilterLanguages returns empty list when no language info",
  async () => {
    await withRollback(async (tx) => {
      const ctx = makeGuestContext(tx);
      const result = await execute({
        schema,
        document: suggestedFilterLanguagesQuery,
        contextValue: ctx,
      });
      assert.deepEqual(result.errors, undefined);
      assert.deepEqual(
        (result.data as { suggestedFilterLanguages: string[] })
          .suggestedFilterLanguages,
        [],
      );
    });
  },
);

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
