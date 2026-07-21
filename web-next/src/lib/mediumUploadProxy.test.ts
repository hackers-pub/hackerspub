import { assertEquals } from "@std/assert";
import {
  createMediumUploadPreflightResponse,
  createMediumUploadProxyRequest,
} from "./mediumUploadProxy.ts";

Deno.test("createMediumUploadPreflightResponse permits cross-origin PUTs", () => {
  const response = createMediumUploadPreflightResponse(
    new Request(
      "https://public.example/medium-uploads?uploadId=123&token=secret",
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "content-type",
        },
      },
    ),
  );

  assertEquals(response.status, 204);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:3000",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Methods"),
    "PUT, OPTIONS",
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Headers"),
    "Content-Type, Content-Length",
  );
  assertEquals(response.headers.get("Access-Control-Max-Age"), "86400");
  assertEquals(response.headers.get("Vary"), "Origin");
});

Deno.test("createMediumUploadProxyRequest targets the internal API safely", async () => {
  const request = new Request(
    "http://localhost:3000/medium-uploads?uploadId=123&token=secret",
    {
      method: "PUT",
      headers: {
        Authorization: "Bearer must-not-be-forwarded",
        "Content-Length": "4",
        "Content-Type": "image/png",
        Cookie: "session=must-not-be-forwarded",
        Origin: "http://localhost:3000",
        "X-Forwarded-Host": "spoofed.example",
      },
      body: new Uint8Array([1, 2, 3, 4]),
    },
  );

  const upstream = createMediumUploadProxyRequest(
    request,
    "http://graphql:8080/graphql",
    "123",
  );

  assertEquals(
    upstream.url,
    "http://graphql:8080/medium-uploads/123?token=secret",
  );
  assertEquals(upstream.method, "PUT");
  assertEquals(upstream.headers.get("Content-Length"), "4");
  assertEquals(upstream.headers.get("Content-Type"), "image/png");
  assertEquals(upstream.headers.get("Origin"), "http://localhost:3000");
  assertEquals(upstream.headers.has("Authorization"), false);
  assertEquals(upstream.headers.has("Cookie"), false);
  assertEquals(upstream.headers.has("X-Forwarded-Host"), false);
  assertEquals(
    new Uint8Array(await upstream.arrayBuffer()),
    new Uint8Array([1, 2, 3, 4]),
  );
});
