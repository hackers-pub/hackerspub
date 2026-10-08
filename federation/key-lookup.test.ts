import { fetchKeyDetailed } from "@fedify/fedify/sig";
import { CryptographicKey } from "@fedify/vocab";
import assert from "node:assert/strict";
import { test } from "node:test";

const keyId = "https://example.com/users/alice#main-key";

test("malformed remote JSON-LD contexts produce an unverifiable key", async () => {
  const result = await fetchKeyDetailed(keyId, CryptographicKey, {
    documentLoader: async () => ({
      documentUrl: keyId,
      contextUrl: null,
      document: {
        "@context": {
          broken: {
            "@id": "https://example.com/ns#broken",
            "@type": "not-an-absolute-iri",
          },
        },
        id: "https://example.com/users/alice",
        type: "Person",
      },
    }),
    contextLoader: async () => {
      throw new Error("Unexpected context fetch");
    },
  });

  assert.equal(result.key, null);
  assert.equal(result.fetchError, undefined);
});

test("remote context transport failures retain their retryable cause", async () => {
  const failure = new TypeError("fetch failed");
  const result = await fetchKeyDetailed(keyId, CryptographicKey, {
    documentLoader: async () => ({
      documentUrl: keyId,
      contextUrl: null,
      document: {
        "@context": "https://example.com/unavailable-context",
        id: "https://example.com/users/alice",
        type: "Person",
      },
    }),
    contextLoader: async () => {
      throw failure;
    },
  });

  assert.equal(result.key, null);
  assert.ok(result.fetchError && "error" in result.fetchError);
  assert.equal(result.fetchError.error, failure);
});
