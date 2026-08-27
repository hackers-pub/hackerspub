import assert from "node:assert";
import test from "node:test";
import { getArticleViewToken } from "./articleViewToken.ts";

function createStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test("article view tokens are article-scoped and expire after 30 minutes", () => {
  const storage = createStorage();
  let nextToken = 0;
  const options = {
    storage,
    now: 1_000,
    generateToken: () => `token-${++nextToken}`,
  };

  assert.equal(getArticleViewToken("article-a", options), "token-1");
  assert.equal(
    getArticleViewToken("article-a", { ...options, now: 1_000 + 29 * 60_000 }),
    "token-1",
  );
  assert.equal(getArticleViewToken("article-b", options), "token-2");
  assert.equal(
    getArticleViewToken("article-a", { ...options, now: 1_000 + 30 * 60_000 }),
    "token-3",
  );
});

test("article view tokens recover from unavailable storage", () => {
  const storage = {
    getItem(): string | null {
      throw new Error("unavailable");
    },
    setItem(): void {
      throw new Error("unavailable");
    },
  };
  assert.equal(
    getArticleViewToken("article", {
      storage,
      generateToken: () => "ephemeral-token",
    }),
    "ephemeral-token",
  );
});
