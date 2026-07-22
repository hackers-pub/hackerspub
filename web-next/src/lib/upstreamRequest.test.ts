import assert from "node:assert";
import test from "node:test";
import type { Uuid } from "@hackerspub/models/uuid";
import { createUpstreamRequestInit } from "./upstreamRequest.ts";

const SESSION_ID = "019f0c7f-8c99-7000-8000-000000000001" as Uuid;

test("createUpstreamRequestInit forwards trusted request metadata", () => {
  const controller = new AbortController();
  const request = new Request("http://web-next:3000/_server", {
    headers: {
      "x-forwarded-for": "203.0.113.4",
      "x-forwarded-host": "public.example",
      "x-forwarded-proto": "https",
    },
    signal: controller.signal,
  });

  const init = createUpstreamRequestInit({
    request,
    sessionId: SESSION_ID,
    behindProxy: true,
    body: "request-body",
  });
  const headers = new Headers(init.headers);

  assert.equal(headers.get("authorization"), `Bearer ${SESSION_ID}`);
  assert.equal(headers.get("x-forwarded-for"), "203.0.113.4");
  assert.equal(headers.get("x-forwarded-host"), "public.example");
  assert.equal(headers.get("x-forwarded-proto"), "https");
  assert.strictEqual(init.signal, request.signal);
  assert.equal(init.body, "request-body");
});

test("createUpstreamRequestInit drops untrusted forwarded headers", () => {
  const request = new Request("http://web-next:3000/_server", {
    headers: {
      "x-forwarded-for": "203.0.113.4",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
    },
  });

  const init = createUpstreamRequestInit({
    request,
    sessionId: null,
    behindProxy: false,
    body: "request-body",
  });
  const headers = new Headers(init.headers);

  assert.equal(headers.has("authorization"), false);
  assert.equal(headers.has("x-forwarded-for"), false);
  assert.equal(headers.has("x-forwarded-host"), false);
  assert.equal(headers.has("x-forwarded-proto"), false);
});
