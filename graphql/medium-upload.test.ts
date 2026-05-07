import assert from "node:assert/strict";
import test from "node:test";
import type { Uuid } from "@hackerspub/models/uuid";
import {
  createMediumUploadSession,
  handleMediumUploadProxy,
} from "./medium-upload.ts";
import { createTestDisk, createTestKv } from "../test/postgres.ts";

test("handleMediumUploadProxy rejects missing content length before reading", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );
  const body = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error("request body should not be read");
    },
  });

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body,
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 411);
});

test("handleMediumUploadProxy accepts exact content length", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );
  const bytes = new Uint8Array([1, 2, 3, 4]);

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(bytes.byteLength),
        },
        body: bytes,
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 204);
  assert.deepEqual(await disk.getBytes(session.key), bytes);
});

test("handleMediumUploadProxy stops reading when body exceeds session length", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.enqueue(new Uint8Array([5]));
      controller.close();
    },
  });

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "4",
        },
        body,
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 413);
  assert.throws(() => disk.getBytes(session.key));
});

test("handleMediumUploadProxy rejects bodies shorter than content length", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );
  const bytes = new Uint8Array([1, 2, 3]);

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "4",
        },
        body: bytes,
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 413);
  assert.throws(() => disk.getBytes(session.key));
});

test("handleMediumUploadProxy responds to OPTIONS preflight with CORS headers", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      {
        method: "OPTIONS",
        headers: {
          "Origin": "http://localhost:5173",
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "Content-Type",
        },
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:5173",
  );
  assert.ok(
    response.headers.get("Access-Control-Allow-Methods")?.includes("PUT"),
  );
  assert.ok(
    response.headers.get("Vary")?.includes("Origin"),
    "preflight should include Vary: Origin",
  );
  assert.ok(
    response.headers.get("Access-Control-Allow-Headers")?.includes(
      "Content-Type",
    ),
    "preflight should allow Content-Type header",
  );
});

// Helper used by the CORS-on-error tests below.
const TEST_ORIGIN = "http://localhost:5173";
function assertCors(response: Response) {
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    TEST_ORIGIN,
  );
  assert.ok(
    response.headers.get("Vary")?.includes("Origin"),
    "response should carry Vary: Origin",
  );
}

test("handleMediumUploadProxy includes CORS headers on 405 wrong method", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      { method: "PATCH", headers: { "Origin": TEST_ORIGIN } },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 405);
  assertCors(response);
});

test("handleMediumUploadProxy includes CORS headers on 404 invalid UUID", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();

  const response = await handleMediumUploadProxy(
    new Request(
      "http://localhost/medium-uploads/not-a-valid-uuid",
      { method: "PUT", headers: { "Origin": TEST_ORIGIN } },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 404);
  assertCors(response);
});

test("handleMediumUploadProxy includes CORS headers on 403 wrong token", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );
  const bytes = new Uint8Array([1, 2, 3, 4]);

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=wrong`,
      {
        method: "PUT",
        headers: {
          "Origin": TEST_ORIGIN,
          "Content-Type": "image/png",
          "Content-Length": "4",
        },
        body: bytes,
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 403);
  assertCors(response);
});

test("handleMediumUploadProxy includes CORS headers on 415 wrong content-type", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );
  const bytes = new Uint8Array([1, 2, 3, 4]);

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      {
        method: "PUT",
        headers: {
          "Origin": TEST_ORIGIN,
          "Content-Type": "text/plain",
          "Content-Length": "4",
        },
        body: bytes,
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 415);
  assertCors(response);
});

test("handleMediumUploadProxy includes CORS headers on 411 missing content-length", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      {
        method: "PUT",
        headers: {
          "Origin": TEST_ORIGIN,
          "Content-Type": "image/png",
          // no Content-Length header
        },
        body: new Uint8Array([1, 2, 3, 4]),
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 411);
  assertCors(response);
});

test("handleMediumUploadProxy includes CORS headers on 413 oversized body", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      controller.enqueue(new Uint8Array([5]));
      controller.close();
    },
  });

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      {
        method: "PUT",
        headers: {
          "Origin": TEST_ORIGIN,
          "Content-Type": "image/png",
          "Content-Length": "4",
        },
        body,
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 413);
  assertCors(response);
});

test("handleMediumUploadProxy includes CORS origin header on successful PUT", async () => {
  const { kv } = createTestKv();
  const disk = createTestDisk();
  const accountId = crypto.randomUUID() as Uuid;
  const session = await createMediumUploadSession(
    kv,
    accountId,
    "image/png",
    4,
  );
  const bytes = new Uint8Array([1, 2, 3, 4]);

  const response = await handleMediumUploadProxy(
    new Request(
      `http://localhost/medium-uploads/${session.id}?token=${session.token}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "4",
          "Origin": "http://localhost:5173",
        },
        body: bytes,
      },
    ),
    kv,
    disk,
  );

  assert.ok(response != null);
  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:5173",
  );
  assert.ok(
    response.headers.get("Vary")?.includes("Origin"),
    "PUT success should include Vary: Origin",
  );
});
