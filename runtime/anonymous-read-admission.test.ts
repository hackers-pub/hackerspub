import { assertEquals, assertRejects } from "@std/assert";
import { spawn } from "node:child_process";
import dns, { type LookupAddress, type LookupOptions } from "node:dns";
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

test("Redis admission connects to a hostname with only an IPv6 address", async (t) => {
  const reservation = createServer().listen({
    host: "::1",
    port: 0,
    ipv6Only: true,
  });
  try {
    await once(reservation, "listening");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")
    ) {
      t.skip("IPv6 loopback is unavailable");
      return;
    }
    throw error;
  }
  const address = reservation.address();
  if (address == null || typeof address === "string")
    throw new Error("No port");
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  const server = spawn(
    "redis-server",
    [
      "--bind",
      "::1",
      "--port",
      String(address.port),
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
  const admin = new Redis({
    host: "::1",
    port: address.port,
    family: 6,
    maxRetriesPerRequest: 20,
    retryStrategy: () => 20,
  });
  admin.on("error", () => {});
  t.after(() => admin.disconnect());
  await admin.ping();
  const origin = new URL("https://ipv6.example.test");
  const key = anonymousReadLedgerKey(origin);
  await admin.hset(key, "format", "1", "limit", "1");
  const actualLookup = dns.lookup;
  const families: number[] = [];
  type LookupCallback = (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family: number,
  ) => void;
  // Keep real TCP/Redis behavior, but make this hostname deterministically
  // AAAA-only regardless of the machine's resolver or hosts-file settings.
  t.mock.method(dns, "lookup", ((
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ) => {
    if (hostname !== "ipv6-only.example.test") {
      return Reflect.apply(actualLookup, dns, [hostname, options, callback]);
    }
    const family =
      options.family === "IPv4"
        ? 4
        : options.family === "IPv6"
          ? 6
          : (options.family ?? 0);
    families.push(family);
    queueMicrotask(() => {
      if (family === 4) {
        const error = Object.assign(new Error("No IPv4 address"), {
          code: "ENOTFOUND",
        });
        callback(error, "", 4);
      } else if (options.all) {
        callback(null, [{ address: "::1", family: 6 }], 6);
      } else {
        callback(null, "::1", 6);
      }
    });
  }) as typeof dns.lookup);
  const store = await createRedisAnonymousReadStore(
    new URL(`redis://ipv6-only.example.test:${address.port}`),
    origin,
    1,
    1000,
  );
  t.after(() => store.close());
  assertEquals(await store.acquire("ipv6-owner"), true);
  assertEquals(families, [0]);
  assertEquals(await admin.hexists(key, "owner:ipv6-owner"), 1);
  await store.release("ipv6-owner");
  assertEquals(await admin.hlen(key), 2);
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
