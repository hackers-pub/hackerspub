import { assertEquals, assertRejects } from "@std/assert";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import test from "node:test";
import { Redis } from "ioredis";
import {
  anonymousReadLedgerKey,
  createMemoryAnonymousReadStore,
  createRedisAnonymousReadStore,
} from "./anonymous-read-admission.ts";

test("memory admission is bounded and releases owners", async () => {
  const store = createMemoryAnonymousReadStore(1);
  assertEquals(await store.acquire("one"), true);
  assertEquals(await store.acquire("two"), false);
  await store.release("one");
  assertEquals(await store.acquire("two"), true);
  await store.close();
  await assertRejects(() => store.acquire("three"));
});

test("Redis ledger is shared, requires provisioning, and permanently fails closed", async (t) => {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  if (address == null || typeof address === "string")
    throw new Error("No port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  const server = spawn(
    "redis-server",
    [
      "--bind",
      "127.0.0.1",
      "--port",
      String(port),
      "--save",
      "",
      "--appendonly",
      "no",
    ],
    { stdio: "ignore" },
  );
  t.after(() => {
    server.kill();
  });
  const url = new URL(`redis://127.0.0.1:${port}`);
  const origin = new URL("https://example.test");
  const admin = new Redis(url.href, {
    maxRetriesPerRequest: 20,
    retryStrategy: () => 20,
  });
  admin.on("error", () => {});
  t.after(() => admin.disconnect());
  await admin.ping();
  const key = anonymousReadLedgerKey(origin);
  const missing = await createRedisAnonymousReadStore(url, origin, 2, 1000);
  await assertRejects(() => missing.acquire("missing"));
  assertEquals(missing.failure, "ledger_missing_or_mismatched");
  await admin.hset(key, "format", "1", "limit", "2");
  await assertRejects(() => missing.acquire("still-closed"));
  const a = await createRedisAnonymousReadStore(url, origin, 2, 1000);
  const b = await createRedisAnonymousReadStore(url, origin, 2, 1000);
  t.after(async () => {
    await a.close();
    await b.close();
    await missing.close();
  });
  assertEquals(await a.acquire("a"), true);
  assertEquals(await b.acquire("b"), true);
  assertEquals(await b.acquire("c"), false);
  await a.release("a");
  assertEquals(await b.acquire("c"), true);
  await admin.del(key);
  await assertRejects(() => a.acquire("d"));
  assertEquals(a.failure, "ledger_missing_or_mismatched");
  await admin.hset(key, "format", "1", "limit", "2");
  await assertRejects(() => a.acquire("e"));
});

test("a stalled Redis command latches the store closed and disconnects", async (t) => {
  let evalCommands = 0;
  let clientClosed = false;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("close", () => {
      clientClosed = true;
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length > 0) {
        const firstEnd = buffer.indexOf("\r\n");
        if (firstEnd < 0) return;
        const count = Number(buffer.subarray(1, firstEnd).toString());
        let offset = firstEnd + 2;
        const args: string[] = [];
        for (let i = 0; i < count; i++) {
          const end = buffer.indexOf("\r\n", offset);
          if (end < 0) return;
          const size = Number(buffer.subarray(offset + 1, end).toString());
          if (buffer.length < end + 2 + size + 2) return;
          args.push(buffer.subarray(end + 2, end + 2 + size).toString());
          offset = end + 2 + size + 2;
        }
        buffer = buffer.subarray(offset);
        switch (args[0]?.toLowerCase()) {
          case "info": {
            const info = "# Server\r\nredis_version:7.0.0\r\n";
            socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
            break;
          }
          case "eval":
            evalCommands++;
            break; // Keep the socket open while withholding the reply.
          default:
            socket.write("+OK\r\n");
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  if (address == null || typeof address === "string")
    throw new Error("No port");
  const store = await createRedisAnonymousReadStore(
    new URL(`redis://127.0.0.1:${address.port}`),
    new URL("https://example.test"),
    2,
    100,
  );
  t.after(() => store.close());
  await assertRejects(() => store.acquire("first"));
  assertEquals(evalCommands, 1);
  assertEquals(typeof store.failure, "string");
  await assertRejects(() => store.acquire("second"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assertEquals(evalCommands, 1);
  assertEquals(clientClosed, true);
});
