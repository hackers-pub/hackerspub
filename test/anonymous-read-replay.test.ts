import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDatabaseResources } from "@hackerspub/runtime/resources";
import { AnonymousReadController } from "../graphql/anonymous-reads.ts";
import { loadAnonymousReadConfig } from "@hackerspub/runtime/config";
import {
  anonymousReadLedgerKey,
  createRedisAnonymousReadStore,
} from "@hackerspub/runtime/anonymous-read-admission";

test(
  "deterministic two-replica repeated/distinct distributed-client replay",
  {
    timeout: 10_000,
    skip:
      process.env.DATABASE_URL == null
        ? "DATABASE_URL is not configured"
        : false,
  },
  async (t) => {
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert.ok(address != null && typeof address !== "string");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const redis = spawn(
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
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    t.after(() => {
      redis.kill();
    });
    const url = new URL(`redis://127.0.0.1:${address.port}`);
    const origin = new URL("https://replay.example");
    const command = async (...args: string[]) =>
      (
        await promisify(execFile)("redis-cli", ["-u", url.href, ...args])
      ).stdout.trim();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Redis did not start")),
        2000,
      );
      redis.stdout?.on("data", (chunk) => {
        if (String(chunk).includes("Ready to accept connections")) {
          clearTimeout(timer);
          resolve();
        }
      });
      redis.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await command(
      "HSET",
      anonymousReadLedgerKey(origin),
      "format",
      "1",
      "limit",
      "2",
    );
    const config = {
      ...loadAnonymousReadConfig({}),
      globalLimit: 2,
      localLimit: 2,
      followerLimit: 2,
      joinWindowMs: 1000,
    };
    const stores = await Promise.all([
      createRedisAnonymousReadStore(url, origin, 2, 1000),
      createRedisAnonymousReadStore(url, origin, 2, 1000),
    ]);
    t.after(async () => {
      await Promise.all(stores.map((store) => store.close()));
    });
    const replicas = stores.map(
      (store) => new AnonymousReadController(store, config),
    );
    const { postgres: sql } = createDatabaseResources({
      url: process.env.DATABASE_URL!,
    });
    t.after(async () => {
      await sql.end();
    });
    const release = Promise.withResolvers<void>();
    const saturated = Promise.withResolvers<void>();
    let workStarts = 0,
      running = 0,
      peak = 0;
    const work = async () => {
      workStarts++;
      running++;
      peak = Math.max(peak, running);
      try {
        await sql`select pg_sleep(0.005)`;
        if (running === 2) saturated.resolve();
        await release.promise;
        return "public";
      } finally {
        running--;
      }
    };
    const req = (identity: number) =>
      new Request("https://replay.example/graphql", {
        headers: { "x-forwarded-for": `192.0.2.${identity}` },
      });
    const baseline: number[] = [],
      loaded: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await replicas[0].cheap(req(i), async () => "layout");
      baseline.push(performance.now() - start);
    }
    const readers = replicas.flatMap((replica, index) => [
      replica.run(req(index), "same-public-query", work),
      replica.run(req(index + 2), "same-public-query", work),
    ]);
    try {
      await saturated.promise;
      assert.equal(
        Number(await command("HLEN", anonymousReadLedgerKey(origin))),
        4,
      ); // two metadata fields + two owners
      const excess = await Promise.allSettled(
        Array.from({ length: 30 }, async (_, i) =>
          replicas[i % 2].run(req(i + 10), `distinct-cursor-${i}`, work),
        ),
      );
      assert.equal(
        excess.filter((result) => result.status === "rejected").length,
        30,
      );
      for (let i = 0; i < 20; i++) {
        const start = performance.now();
        assert.equal(
          await replicas[i % 2].cheap(req(i), async () => "layout"),
          "layout",
        );
        assert.equal(
          await replicas[i % 2].authenticate(async () => "sign-in"),
          "sign-in",
        );
        loaded.push(performance.now() - start);
      }
      assert.equal(workStarts, 2);
      assert.equal(peak, 2);
      assert.equal(
        replicas.reduce((sum, replica) => sum + replica.stats.followers, 0),
        2,
      );
      const percentile = (values: number[], fraction: number) =>
        values.toSorted((a, b) => a - b)[
          Math.ceil(values.length * fraction) - 1
        ];
      t.diagnostic(
        JSON.stringify({
          fixture:
            "controller replay with real Redis/PostgreSQL; not a staging SLO",
          admittedConcurrency: peak,
          databaseWorkStarts: workStarts,
          queued: 0,
          sharedFollowers: 2,
          overloadResponses: 30,
          baselineInteractiveP95Ms: percentile(baseline, 0.95),
          baselineInteractiveP99Ms: percentile(baseline, 0.99),
          loadedInteractiveP95Ms: percentile(loaded, 0.95),
          loadedInteractiveP99Ms: percentile(loaded, 0.99),
        }),
      );
    } finally {
      release.resolve();
      await Promise.allSettled(readers);
    }
    assert.equal(
      Number(await command("HLEN", anonymousReadLedgerKey(origin))),
      2,
    );
    assert.equal(
      replicas.reduce((sum, replica) => sum + replica.stats.active, 0),
      0,
    );
  },
);
