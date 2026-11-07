import { generateCryptoKeyPair, signRequest } from "@fedify/fedify";
import { CryptographicKey, Person } from "@fedify/vocab";
import { accountTable, instanceTable } from "@hackerspub/models/schema";
import { addPostToTimeline } from "@hackerspub/models/timeline";
import { generateUuidV7 } from "@hackerspub/models/uuid";
import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, postgres as observer } from "./database.ts";
import {
  insertAccountWithActor,
  insertNotePost,
  withExclusiveTestDatabase,
} from "./postgres.ts";
import {
  fixtureProtocolConfig,
  type FixtureConfig,
  type FixtureStats,
} from "./protocol-isolation-process.ts";

const query = `query IsolationFixture {
  viewer { id username postCount actor { id name handle } }
  personalTimeline(first: 5) {
    edges { node { id content actor { id name } } }
    pageInfo { hasNextPage }
  }
}`;

interface ProcessFixture {
  child: ChildProcess;
  pid: number;
  url: string;
  request(kind: string): Promise<Record<string, unknown>>;
  stats(): Promise<FixtureStats>;
  close(): Promise<void>;
}

async function start(config: FixtureConfig): Promise<ProcessFixture> {
  const child = fork(
    fileURLToPath(new URL("./protocol-isolation-process.ts", import.meta.url)),
    ["child"],
    {
      env: {
        ...process.env,
        SENTRY_DSN: "",
        PROTOCOL_ISOLATION_FIXTURE: JSON.stringify(config),
      },
      execArgv: ["--import", "temporal-polyfill/global"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-12000);
    });
  const ready = Promise.withResolvers<{ pid: number; port?: number }>();
  let nextId = 0;
  const replies = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>
  >();
  child.on("message", (message: Record<string, unknown>) => {
    if (message.kind === "ready")
      ready.resolve(message as unknown as { pid: number; port?: number });
    else if (message.kind === "fatal")
      ready.reject(new Error(`${String(message.message)}\n${output}`));
    if (typeof message.id === "number")
      replies.get(message.id)?.resolve(message);
  });
  child.once("exit", (code, signal) => {
    const error = new Error(
      `${config.role} exited (${code}/${signal})\n${output}`,
    );
    ready.reject(error);
    for (const reply of replies.values()) reply.reject(error);
  });
  const startupTimer = globalThis.setTimeout(() => {
    child.kill("SIGKILL");
    ready.reject(new Error(`${config.role} startup timed out\n${output}`));
  }, 30000);
  let address: { pid: number; port?: number };
  try {
    address = await ready.promise;
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  const request = async (kind: string) => {
    const id = nextId++;
    const reply = Promise.withResolvers<Record<string, unknown>>();
    replies.set(id, reply);
    const timer = globalThis.setTimeout(
      () =>
        reply.reject(new Error(`${config.role} ${kind} timed out\n${output}`)),
      10000,
    );
    try {
      child.send({ kind, id });
      return await reply.promise;
    } finally {
      clearTimeout(timer);
      replies.delete(id);
    }
  };
  return {
    child,
    pid: address.pid,
    url: `http://127.0.0.1:${address.port}`,
    request,
    async stats() {
      return (await request("stats")).value as FixtureStats;
    },
    async close() {
      if (child.exitCode != null || child.signalCode != null) return;
      const exited = once(child, "exit");
      const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        child.send({ kind: "shutdown" });
        const [code, signal] = await exited;
        assert.equal(
          signal,
          null,
          `${config.role} required forced shutdown\n${output}`,
        );
        assert.equal(code, 0, `${config.role} shutdown failed\n${output}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function startSsr(
  apiUrl: string,
): Promise<{ url: string; close(): Promise<void> }> {
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  assert.ok(address != null && typeof address !== "string");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const url = `http://127.0.0.1:${address.port}`;
  const child = spawn(
    process.execPath,
    ["--import", "temporal-polyfill/global", ".output/server/index.mjs"],
    {
      cwd: fileURLToPath(new URL("../web-next/", import.meta.url)),
      env: {
        ...process.env,
        SENTRY_DSN: "",
        API_URL: `${apiUrl}/graphql`,
        ORIGIN: url,
        HOST: "127.0.0.1",
        PORT: String(address.port),
        NITRO_PORT: String(address.port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-12000);
    });
  const close = async () => {
    if (child.exitCode != null || child.signalCode != null) return;
    const exited = once(child, "exit");
    const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      child.kill("SIGTERM");
      const [, signal] = await exited;
      assert.notEqual(signal, "SIGKILL", output);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    await waitFor(async () => {
      if (child.exitCode != null)
        throw new Error(`SSR startup failed\n${output}`);
      try {
        const response = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.arrayBuffer();
        return true;
      } catch {
        return false;
      }
    }, `SSR startup timed out\n${output}`);
  } catch (error) {
    await close();
    throw error;
  }
  return { url, close };
}

const percentile = (values: number[], fraction: number) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const summary = (values: number[]) => ({
  count: values.length,
  p95Ms: percentile(values, 0.95),
  p99Ms: percentile(values, 0.99),
});

async function waitFor(
  check: () => Promise<boolean>,
  message: string,
): Promise<void> {
  const until = performance.now() + 10000;
  while (performance.now() < until) {
    if (await check()) return;
    await setTimeout(10);
  }
  throw new Error(message);
}

test(
  "separate protocol/API processes preserve authenticated timeline latency and durable inbox delivery",
  {
    timeout: 240000,
    skip:
      process.env.DATABASE_URL == null
        ? "DATABASE_URL is not configured"
        : false,
  },
  async (t) => {
    await withExclusiveTestDatabase(async () => {
      const runId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
      const username = `isolation_${runId}`;
      const host = `${runId}.isolation.example`;
      const { account } = await db.transaction(async (tx) => {
        const seeded = await insertAccountWithActor(tx, {
          username,
          name: "Isolation fixture",
          email: `${username}@example.com`,
          host,
        });
        for (let i = 0; i < 5; i++) {
          const { post } = await insertNotePost(tx, {
            account: seeded.account,
            content: `Isolation fixture post ${i}`,
            published: new Date(Date.now() - (i + 1) * 1000),
          });
          await addPostToTimeline(tx, post);
        }
        return seeded;
      });
      const keys = await generateCryptoKeyPair("RSASSA-PKCS1-v1_5");
      const signerUrl = "https://signer.isolation.example/actor";
      const keyId = new URL(`${signerUrl}#main-key`);
      const signerDocument = await new Person({
        id: new URL(signerUrl),
        preferredUsername: "signer",
        publicKey: new CryptographicKey({
          id: keyId,
          owner: new URL(signerUrl),
          publicKey: keys.publicKey,
        }),
      }).toJsonLd();
      const config = {
        runId,
        accountId: account.id,
        sessionId: generateUuidV7(),
        signerUrl,
        signerDocument,
      };
      const processes: ProcessFixture[] = [];
      let api: ProcessFixture | undefined;
      let protocol: ProcessFixture | undefined;
      let worker: ProcessFixture | undefined;
      let ssr: Awaited<ReturnType<typeof startSsr>> | undefined;
      let monitorRunning = true;
      let monitor: Promise<void> | undefined;
      const connectionPeaks: Record<string, number> = {};
      let aggregateConnectionPeak = 0;
      try {
        protocol = await start({ ...config, role: "protocol" });
        processes.push(protocol);
        api = await start({ ...config, role: "interactive" });
        processes.push(api);
        worker = await start({ ...config, role: "worker" });
        processes.push(worker);
        const protocolServer = protocol;
        const apiServer = api;
        const workerServer = worker;
        if (process.env.PROTOCOL_ISOLATION_SSR === "1") {
          ssr = await startSsr(apiServer.url);
        }
        assert.equal(new Set(processes.map((p) => p.pid)).size, 3);
        monitor = (async () => {
          while (monitorRunning) {
            const rows =
              await observer`select application_name, count(*)::int as count from pg_stat_activity where application_name like ${`hp-isolation-${runId}-%`} group by application_name`;
            for (const row of rows)
              connectionPeaks[row.application_name] = Math.max(
                connectionPeaks[row.application_name] ?? 0,
                row.count,
              );
            aggregateConnectionPeak = Math.max(
              aggregateConnectionPeak,
              rows.reduce((total, row) => total + Number(row.count), 0),
            );
            await setTimeout(10);
          }
        })();
        void monitor.catch(() => {});
        const read = async () => {
          const started = performance.now();
          const response = await fetch(`${apiServer.url}/graphql`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.sessionId}`,
            },
            body: JSON.stringify({ query }),
            signal: AbortSignal.timeout(5000),
          });
          const body = (await response.json()) as {
            errors?: unknown;
            data?: {
              viewer?: { username: string };
              personalTimeline?: { edges: unknown[] };
            };
          };
          assert.equal(response.status, 200);
          assert.equal(body.errors, undefined, JSON.stringify(body.errors));
          assert.equal(body.data?.viewer?.username, username);
          assert.equal(body.data?.personalTimeline?.edges.length, 5);
          return performance.now() - started;
        };
        const readSsr = async () => {
          assert.ok(ssr != null);
          const started = performance.now();
          const response = await fetch(`${ssr.url}/feed`, {
            headers: {
              cookie: `session=${config.sessionId}`,
              "accept-language": "en-US",
            },
            redirect: "manual",
            signal: AbortSignal.timeout(10000),
          });
          const html = await response.text();
          assert.equal(response.status, 200, html.slice(0, 1500));
          assert.match(
            html,
            /<p>Isolation fixture post 0<\/p>/,
            `Feed did not server-render the seeded post: ${html.slice(0, 1500)}`,
          );
          return performance.now() - started;
        };
        const measure = async (count = 80, ssrTimes: number[] = []) => {
          const times: number[] = [];
          for (let i = 0; i < count; i += 2) {
            times.push(...(await Promise.all([read(), read()])));
            if (ssr != null) ssrTimes.push(await readSsr());
            const health = await fetch(`${apiServer.url}/health`);
            assert.equal(health.status, 200);
            await health.arrayBuffer();
          }
          assert.equal(apiServer.child.exitCode, null);
          assert.equal((await apiServer.stats()).pid, apiServer.pid);
          return times;
        };
        const fetchObject = async (id: string) => {
          const started = performance.now();
          const response = await fetch(
            `${protocolServer.url}/ap/objects/${id}`,
            {
              headers: { accept: "application/activity+json" },
              signal: AbortSignal.timeout(5000),
            },
          );
          const body = await response.text();
          return {
            status: response.status,
            body,
            elapsed: performance.now() - started,
          };
        };
        for (let i = 0; i < 12; i++) await read();
        if (ssr != null) for (let i = 0; i < 12; i++) await readSsr();
        const valid = await fetchObject("normal");
        assert.equal(valid.status, 200);
        assert.equal(JSON.parse(valid.body).type, "Note");
        const baselineSsr: number[] = [];
        const baseline = await measure(80, baselineSsr);
        const shedTimes: number[] = [];
        const loaded: Record<string, ReturnType<typeof summary>> = {};
        const loadedSsr: Record<string, ReturnType<typeof summary>> = {};
        for (const dependency of ["sql", "loader"]) {
          let run = true;
          const generators = Array.from({ length: 4 }, async () => {
            while (run) {
              const response = await fetchObject(dependency);
              assert.ok([503, 504].includes(response.status), response.body);
              if (response.status === 503) shedTimes.push(response.elapsed);
              await setTimeout(10);
            }
          });
          const generating = Promise.all(generators);
          void generating.catch(() => {});
          try {
            await waitFor(
              async () => (await protocolServer.stats()).http.active === 2,
              "protocol admission did not fill",
            );
            const state = await protocolServer.stats();
            assert.equal(state.http.active, 2);
            assert.equal(
              (await fetch(`${protocolServer.url}/health`)).status,
              200,
            );
            const ssrTimes: number[] = [];
            loaded[dependency] = summary(await measure(80, ssrTimes));
            if (ssr != null) loadedSsr[dependency] = summary(ssrTimes);
          } finally {
            run = false;
            await generating;
            await waitFor(
              async () => (await protocolServer.stats()).http.active === 0,
              "protocol dependency ownership did not drain",
            );
          }
        }
        const loaderTimeouts = await Promise.all([
          fetchObject("loader"),
          fetchObject("loader"),
        ]);
        assert.deepEqual(
          loaderTimeouts.map((r) => r.status),
          [504, 504],
        );
        const loaderAfterDeadline = await protocolServer.stats();
        assert.equal(loaderAfterDeadline.http.active, 2);
        assert.equal(loaderAfterDeadline.loaders?.active, 2);
        await waitFor(
          async () => (await protocolServer.stats()).http.active === 0,
          "ignored loader cancellation did not drain",
        );
        // A deadline response must not release either still-running SQL slot.
        const stalls = [fetchObject("sql"), fetchObject("sql")];
        const timedOut = await Promise.all(stalls);
        assert.deepEqual(
          timedOut.map((r) => r.status),
          [504, 504],
        );
        const afterDeadline = await protocolServer.stats();
        assert.equal(afterDeadline.http.active, 2);
        assert.equal(afterDeadline.sql?.active, 2);
        const rejectedInboxId = `${signerUrl}/activities/${crypto.randomUUID()}`;
        const sendInbox = async (id: string) => {
          const request = await signRequest(
            new Request(`${protocolServer.url}/ap/inbox`, {
              method: "POST",
              headers: { "content-type": "application/activity+json" },
              body: JSON.stringify({
                "@context": "https://www.w3.org/ns/activitystreams",
                id,
                type: "Follow",
                actor: signerUrl,
                object: `${protocolServer.url}/ap/actors/fixture`,
              }),
            }),
            keys.privateKey,
            keyId,
          );
          const response = await fetch(request);
          const body = await response.text();
          return { status: response.status, body };
        };
        assert.equal((await sendInbox(rejectedInboxId)).status, 503);
        assert.equal(
          (await protocolServer.stats()).http.admitted,
          afterDeadline.http.admitted,
        );
        assert.ok(
          !(await workerServer.stats()).consumed.includes(rejectedInboxId),
        );
        const queued = await observer.unsafe(
          `select count(*)::int as count from hp_iso_queue_${runId} where message::text like $1`,
          [`%${rejectedInboxId}%`],
        );
        assert.equal(queued[0].count, 0);
        await waitFor(
          async () => (await protocolServer.stats()).http.active === 0,
          "SQL drain did not complete",
        );
        const accepted = await sendInbox(rejectedInboxId);
        assert.equal(accepted.status, 202, accepted.body);
        await waitFor(
          async () =>
            (await workerServer.stats()).consumed.includes(rejectedInboxId),
          "accepted inbox did not reach separate worker",
        );
        assert.equal((await protocolServer.stats()).consumed.length, 0);
        assert.equal((await apiServer.stats()).consumed.length, 0);
        // CPU work deliberately blocks only the protocol child. No protocol
        // shedding-latency assertion is made while its own event loop is blocked.
        let cpuRun = true;
        const cpuStarted = new Promise<void>((resolve) => {
          const listener = (message: Record<string, unknown>) => {
            if (message.kind === "cpu-start") {
              protocolServer.child.off("message", listener);
              resolve();
            }
          };
          protocolServer.child.on("message", listener);
        });
        const cpu = (async () => {
          while (cpuRun) {
            const result = await fetchObject("cpu");
            assert.ok([200, 504].includes(result.status));
          }
        })();
        void cpu.catch(() => {});
        let cpuMeasurement: ReturnType<typeof summary>;
        const cpuSsr: number[] = [];
        try {
          await Promise.race([cpuStarted, cpu]);
          cpuMeasurement = summary(await measure(80, cpuSsr));
        } finally {
          cpuRun = false;
          await cpu;
        }
        const finalStats = await protocolServer.stats();
        assert.ok(finalStats.peaks.http <= fixtureProtocolConfig.limit);
        assert.ok(finalStats.peaks.sql <= fixtureProtocolConfig.sqlLimit);
        assert.ok(
          finalStats.peaks.loaders <= fixtureProtocolConfig.loaderLimit,
        );
        assert.ok(finalStats.peaks.sql >= 2);
        assert.ok(finalStats.peaks.loaders >= 2);
        assert.equal(finalStats.sql?.nativeCancellations, 0);
        assert.equal(finalStats.http.active, 0);
        assert.equal(finalStats.sql?.active, 0);
        assert.equal(finalStats.loaders?.active, 0);
        assert.ok(shedTimes.length > 0);
        assert.ok(
          Math.max(...shedTimes) < 250,
          `slow shedding: ${Math.max(...shedTimes)}ms`,
        );
        for (const result of [...Object.values(loaded), cpuMeasurement]) {
          assert.ok(result.p99Ms <= 500, `loaded p99: ${result.p99Ms}`);
          assert.ok(
            result.p99Ms - percentile(baseline, 0.99) <= 100,
            `p99 increase: ${result.p99Ms - percentile(baseline, 0.99)}`,
          );
        }
        if (ssr != null) {
          for (const result of [...Object.values(loadedSsr), summary(cpuSsr)]) {
            assert.ok(result.p99Ms <= 500, `SSR loaded p99: ${result.p99Ms}`);
            assert.ok(
              result.p99Ms - percentile(baselineSsr, 0.99) <= 100,
              `SSR p99 increase: ${result.p99Ms - percentile(baselineSsr, 0.99)}`,
            );
          }
        }
        for (const [name, count] of Object.entries(connectionPeaks))
          assert.ok(
            count <= (name.endsWith("-worker") ? 3 : 2),
            `${name}: ${count}`,
          );
        await protocolServer.request("stop-admission");
        for (const role of ["interactive", "protocol", "worker"]) {
          assert.ok(connectionPeaks[`hp-isolation-${runId}-${role}`] > 0);
        }
        assert.ok(aggregateConnectionPeak <= 7);
        assert.equal((await fetch(`${protocolServer.url}/health`)).status, 503);
        await protocolServer.close();
        await read();
        if (ssr != null) await readSsr();
        assert.equal((await fetch(`${apiServer.url}/health`)).status, 200);
        t.diagnostic(
          JSON.stringify({
            fixture:
              "separate processes; actual Yoga/schema/session/five-post personal timeline; controlled Fedify Note dispatchers; real PostgreSQL queue/worker",
            processCount: ssr == null ? 3 : 4,
            baseline: summary(baseline),
            loaded,
            cpu: cpuMeasurement,
            ssr:
              ssr == null
                ? null
                : {
                    baseline: summary(baselineSsr),
                    loaded: loadedSsr,
                    cpu: summary(cpuSsr),
                    artifact:
                      "web-next/.output/server/index.mjs; rebuild current source before this opt-in run",
                  },
            interactiveErrors: 0,
            readinessFailures: 0,
            restarts: 0,
            shed: { count: shedTimes.length, maxMs: Math.max(...shedTimes) },
            peaks: finalStats.peaks,
            connectionPeaks,
            aggregateConnectionPeak,
            configuredConnections: {
              interactive: 2,
              protocol: 2,
              worker: 2,
              workerListenExtra: 1,
            },
            postDeadlineOwned: {
              http: afterDeadline.http.active,
              sql: afterDeadline.sql?.active,
              loaders: loaderAfterDeadline.loaders?.active,
            },
            consumed: (await workerServer.stats()).consumed.length,
            pending: `full application protocol dispatchers, proxy${ssr == null ? ", current-build SSR/feed" : ""}; production SLO`,
          }),
        );
      } finally {
        monitorRunning = false;
        const closed = await Promise.allSettled([
          monitor,
          ssr?.close(),
          ...processes.toReversed().map((child) => child.close()),
        ]);
        try {
          await observer.unsafe(`drop table if exists hp_iso_queue_${runId}`);
          await observer.unsafe(`drop table if exists hp_iso_kv_${runId}`);
        } finally {
          await db.delete(accountTable).where(eq(accountTable.id, account.id));
          await db.delete(instanceTable).where(eq(instanceTable.host, host));
        }
        const errors = closed.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        assert.deepEqual(errors, [], "Fixture cleanup failed");
      }
    });
  },
);
