import assert from "node:assert";
import test from "node:test";
import type { APIEvent } from "@solidjs/start/server";
import { OPTIONS } from "./medium-uploads.ts";

test("OPTIONS permits cross-origin upload preflights", () => {
  const request = new Request(
    "https://public.example/medium-uploads?uploadId=123&token=secret",
    {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:3000" },
    },
  );

  const response = OPTIONS({ request } as APIEvent);

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:3000",
  );
  assert.equal(
    response.headers.get("Access-Control-Allow-Methods"),
    "PUT, OPTIONS",
  );
});
