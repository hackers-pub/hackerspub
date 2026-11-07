import assert from "node:assert/strict";
import test from "node:test";
import {
  createDatabaseResources,
  getDatabaseConnectionOptions,
} from "./resources.ts";
import { getSqlWorkStats } from "./sql-work.ts";
import {
  runWithRequestWork,
  type RequestWorkFailure,
} from "@hackerspub/models/request-work";
import postgres from "postgres";

test("protocol SQL budgets override URL GUCs and unsafe startup options are rejected", () => {
  const config = {
    url: "postgres://localhost/test?statement_timeout=0&STATEMENT_TIMEOUT=0&lock_timeout=0&Lock_Timeout=0&idle_in_transaction_session_timeout=0&IDLE_IN_TRANSACTION_SESSION_TIMEOUT=0&application_name=wrong&APPLICATION_NAME=wrong&max_pipeline=99&connect_timeout=900",
    protocolWork: { limit: 32, timeoutMs: 5000 },
  };
  const result = getDatabaseConnectionOptions(config);
  const url = new URL(result.url);
  assert.equal(url.searchParams.get("statement_timeout"), "5000ms");
  assert.equal(url.searchParams.get("lock_timeout"), "1000ms");
  assert.equal(
    url.searchParams.get("idle_in_transaction_session_timeout"),
    "5000ms",
  );
  assert.equal(result.options.max, 4);
  assert.equal(result.options.max_pipeline, 1);
  assert.equal(result.options.connect_timeout, 5);
  assert.equal(url.searchParams.get("application_name"), "hackerspub-protocol");
  for (const name of ["options", "OPTIONS", "OpTiOnS"]) {
    assert.throws(
      () =>
        getDatabaseConnectionOptions({
          ...config,
          url: `postgres://localhost/test?${name}=-c%20statement_timeout%3D0`,
        }),
      /DATABASE_URL/,
    );
  }
  const ordinary = getDatabaseConnectionOptions({ url: config.url });
  assert.equal(ordinary.url, config.url);
  assert.equal(ordinary.options.max, 20);
  assert.equal(ordinary.options.max_pipeline, undefined);
});

test(
  "actual protocol connections enforce URL-overridden server budgets and report expiry",
  {
    skip:
      process.env.DATABASE_URL == null ? "DATABASE_URL not configured" : false,
    timeout: 5000,
  },
  async () => {
    const url = new URL(process.env.DATABASE_URL!);
    url.searchParams.set("statement_timeout", "0");
    url.searchParams.set("lock_timeout", "0");
    url.searchParams.set("idle_in_transaction_session_timeout", "0");
    url.searchParams.set("STATEMENT_TIMEOUT", "0");
    url.searchParams.set("Lock_Timeout", "0");
    url.searchParams.set("IDLE_IN_TRANSACTION_SESSION_TIMEOUT", "0");
    url.searchParams.set("application_name", "wrong");
    url.searchParams.set("APPLICATION_NAME", "wrong");
    const { postgres: sql } = createDatabaseResources({
      url: url.href.replace(url.host, `${url.host},${url.host}`),
      maxConnections: 1,
      protocolWork: { limit: 8, timeoutMs: 150 },
    });
    try {
      assert.equal(
        (await sql`show statement_timeout`)[0].statement_timeout,
        "150ms",
      );
      assert.equal((await sql`show lock_timeout`)[0].lock_timeout, "150ms");
      assert.equal(
        (await sql`show idle_in_transaction_session_timeout`)[0]
          .idle_in_transaction_session_timeout,
        "150ms",
      );
      assert.equal(
        (await sql`show application_name`)[0].application_name,
        "hackerspub-protocol",
      );
      const failures: RequestWorkFailure[] = [];
      const started = performance.now();
      await assert.rejects(
        () =>
          runWithRequestWork(
            new AbortController().signal,
            async () => {
              await sql`select pg_sleep(2)`;
            },
            { onFailure: (failure) => failures.push(failure) },
          ),
        { code: "57014" },
      );
      assert.ok(performance.now() - started < 1500);
      assert.equal(failures[0]?.kind, "timeout");
      assert.equal(getSqlWorkStats(sql)?.active, 0);
      assert.equal(getSqlWorkStats(sql)?.nativeCancellations, 0);
      assert.equal((await sql`select 1 as value`)[0].value, 1);
    } finally {
      await sql.end();
    }
  },
);

test(
  "actual protocol lock waits end under the finite role budget",
  {
    skip:
      process.env.DATABASE_URL == null ? "DATABASE_URL not configured" : false,
    timeout: 6000,
  },
  async () => {
    const blocker = postgres(process.env.DATABASE_URL!, { max: 1 });
    const { postgres: sql } = createDatabaseResources({
      url: process.env.DATABASE_URL!,
      maxConnections: 1,
      protocolWork: { limit: 8, timeoutMs: 2000 },
    });
    const key = 914_443_000 + process.pid;
    try {
      await blocker`select pg_advisory_lock(${key})`;
      const failures: RequestWorkFailure[] = [];
      await assert.rejects(
        () =>
          runWithRequestWork(
            new AbortController().signal,
            async () => {
              await sql`select pg_advisory_lock(${key})`;
            },
            { onFailure: (failure) => failures.push(failure) },
          ),
        { code: "55P03" },
      );
      assert.equal(failures[0]?.kind, "timeout");
      assert.equal(getSqlWorkStats(sql)?.active, 0);
    } finally {
      await blocker`select pg_advisory_unlock(${key})`;
      await blocker.end();
      await sql.end();
    }
  },
);

test("protocol SQL options preserve Postgres.js multi-host authorities and ports", async () => {
  const original =
    "postgres://user:p%40ss@db1:5432,db2:5433/app?STATEMENT_TIMEOUT=0&Lock_Timeout=0&sslmode=require";
  const result = getDatabaseConnectionOptions({
    url: original,
    protocolWork: { limit: 8, timeoutMs: 150 },
  });
  assert.ok(
    result.url.startsWith("postgres://user:p%40ss@db1:5432,db2:5433/app?"),
  );
  const sql = postgres(result.url, result.options);
  try {
    assert.deepEqual(sql.options.host, ["db1", "db2"]);
    assert.deepEqual(sql.options.port, [5432, 5433]);
    assert.equal(sql.options.pass, "p@ss");
    assert.equal(sql.options.connection.statement_timeout, "150ms");
    assert.equal(sql.options.connection.lock_timeout, "150ms");
    assert.equal(sql.options.connection.STATEMENT_TIMEOUT, undefined);
    assert.equal(sql.options.ssl, "require");
  } finally {
    await sql.end();
  }
  assert.throws(
    () =>
      getDatabaseConnectionOptions({
        url: `${original}&OpTiOnS=-c%20statement_timeout%3D0`,
        protocolWork: { limit: 8, timeoutMs: 150 },
      }),
    /DATABASE_URL/,
  );
});
