import { Redis } from "ioredis";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import {
  anonymousReadLedgerKey,
  createRedisAnonymousReadStore,
} from "../runtime/anonymous-read-admission.ts";
import { provisionSmokeAdmissionLedger } from "./smoke-admission.ts";

test(
  "smoke provisions isolated admission without replacing or clearing shared ownership",
  { timeout: 10000 },
  async (t) => {
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert.ok(address != null && typeof address !== "string");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const url = new URL(`redis://127.0.0.1:${address.port}`);
    const server = spawn(
      "redis-server",
      [
        "--bind",
        "127.0.0.1",
        "--port",
        String(address.port),
        "--save",
        "",
        "--appendonly",
        "no",
      ],
      { stdio: "ignore" },
    );
    const serverExit = once(server, "exit");
    // A failed spawn rejects this immediately, before teardown gets to await it.
    void serverExit.catch(() => {});
    let client: Redis | undefined;
    t.after(async () => {
      client?.disconnect();
      let force: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        if (server.exitCode == null && server.signalCode == null) {
          server.kill();
          force = setTimeout(() => server.kill("SIGKILL"), 1000);
        }
        await Promise.race([
          serverExit,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Redis fixture did not exit")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(force);
        clearTimeout(deadline);
        server.unref();
      }
    });
    client = new Redis(url.href, { retryStrategy: () => 20 });
    client.on("error", () => {});
    await client.ping();
    const sharedKey = anonymousReadLedgerKey(new URL("https://shared.example"));
    const shared = { format: "1", limit: "8", "owner:existing": "1" };
    await client.hset(sharedKey, shared);
    const origin = new URL(`http://standalone-smoke-${randomUUID()}.invalid`);
    const key = anonymousReadLedgerKey(origin);
    const cleanup = await provisionSmokeAdmissionLedger(client, origin, 2);
    const store = await createRedisAnonymousReadStore(url, origin, 2, 1000);
    t.after(() => store.close());
    assert.equal(store.failure, undefined);
    assert.equal(await store.acquire("live"), true);
    await assert.rejects(
      provisionSmokeAdmissionLedger(client, origin, 2),
      /already exists/,
    );
    await assert.rejects(cleanup(false), /did not drain/);
    await assert.rejects(cleanup(true), /still has owners/);
    assert.equal(await client.hget(key, "owner:live"), "1");
    await store.release("live");
    await store.close();
    await cleanup(true);
    assert.equal(await client.exists(key), 0);
    assert.deepEqual(await client.hgetall(sharedKey), shared);
  },
);
