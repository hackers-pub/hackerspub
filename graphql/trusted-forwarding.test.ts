import assert from "node:assert";
import test from "node:test";
import { applyTrustedForwarding } from "./trusted-forwarding.ts";

function connectionInfo(
  hostname = "172.18.0.2",
): Deno.ServeHandlerInfo<Deno.NetAddr> {
  return {
    remoteAddr: { transport: "tcp", hostname, port: 43210 },
    completed: Promise.resolve(),
  };
}

test("applyTrustedForwarding ignores spoofed headers when disabled", async () => {
  const request = new Request("http://internal:8080/graphql", {
    headers: {
      "x-forwarded-for": "203.0.113.4",
      "x-forwarded-host": "public.example",
      "x-forwarded-proto": "https",
    },
  });
  const info = connectionInfo();

  const result = await applyTrustedForwarding(request, info, false);

  assert.strictEqual(result.request, request);
  assert.strictEqual(result.connectionInfo, info);
  assert.equal(result.request.url, "http://internal:8080/graphql");
  assert.equal(result.connectionInfo.remoteAddr.hostname, "172.18.0.2");
});

test("applyTrustedForwarding applies normalized proxy metadata", async () => {
  const controller = new AbortController();
  const request = new Request("http://internal:8080/graphql", {
    method: "POST",
    headers: {
      authorization: "Bearer session-id",
      cookie: "session=session-id",
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.4",
      "x-forwarded-host": "public.example",
      "x-forwarded-proto": "https",
    },
    body: '{"query":"{__typename}"}',
    signal: controller.signal,
  });

  const result = await applyTrustedForwarding(
    request,
    connectionInfo(),
    true,
  );

  assert.equal(result.request.url, "https://public.example/graphql");
  assert.equal(
    result.request.headers.get("authorization"),
    "Bearer session-id",
  );
  assert.equal(result.request.headers.get("cookie"), "session=session-id");
  assert.equal(await result.request.text(), '{"query":"{__typename}"}');
  assert.equal(result.connectionInfo.remoteAddr.hostname, "203.0.113.4");
  controller.abort();
  assert.equal(result.request.signal.aborted, true);
});

test("applyTrustedForwarding rejects unnormalized client address chains", async () => {
  const request = new Request("http://internal:8080/graphql", {
    headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.4" },
  });

  const result = await applyTrustedForwarding(
    request,
    connectionInfo(),
    true,
  );

  assert.equal(result.connectionInfo.remoteAddr.hostname, "172.18.0.2");
});
