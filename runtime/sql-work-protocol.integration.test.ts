import {
  getRequestWorkOutcome,
  runWithRequestWork,
} from "@hackerspub/models/request-work";
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import postgres from "postgres";
import { getSqlWorkStats, trackSqlWork } from "./sql-work.ts";

const databaseUrl = process.env.DATABASE_URL;
const databaseTest = {
  skip: databaseUrl == null ? "DATABASE_URL is not configured" : false,
  timeout: 10_000,
};

function createSql() {
  const url = new URL(databaseUrl!);
  // Tests enforce their own short server budgets independently of root config.
  url.searchParams.delete("options");
  for (const [key, value] of Object.entries({
    statement_timeout: "200",
    lock_timeout: "100",
    idle_in_transaction_session_timeout: "1000",
    max_pipeline: "1",
  }))
    url.searchParams.set(key, value);
  return trackSqlWork(
    postgres(url.href, {
      max: 1,
      connect_timeout: 2,
    }),
    { strict: { limit: 8 } },
  );
}

test(
  "strict real SQL retains active and queued work after abort without cancellation",
  databaseTest,
  async () => {
    const sql = createSql();
    const abort = new AbortController();
    let nativeCancellations = 0;
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      await sql`select 1`;
      const started = performance.now();
      const work = runWithRequestWork(abort.signal, async () => {
        const queries = [
          sql`select pg_sleep(5)`,
          sql`select 2 as value`,
          sql`select 3 as value`,
        ];
        for (const query of queries) {
          const native = Reflect.get(query, "canceller");
          Reflect.set(query, "canceller", (...args: unknown[]) => {
            nativeCancellations++;
            return Reflect.apply(native, query, args);
          });
        }
        const completed = Promise.allSettled(queries);
        await setTimeout(30);
        abort.abort();
        assert.equal(getSqlWorkStats(sql)?.active, 3);
        await setTimeout(30);
        assert.equal(getSqlWorkStats(sql)?.active, 3);
        results = await completed;
      });
      await work;
      assert.equal(nativeCancellations, 0);
      assert.equal(results[0].status, "rejected");
      if (results[0].status === "rejected")
        assert.equal(results[0].reason.code, "57014");
      assert.equal(results[1].status, "fulfilled");
      assert.equal(results[2].status, "fulfilled");
      assert.ok(performance.now() - started < 2500);
      assert.equal(getSqlWorkStats(sql)?.active, 0);
      assert.equal((await sql`select 4 as value`)[0].value, 4);
    } finally {
      await sql.end();
    }
  },
);

test(
  "strict real cold connection abort leaves the pool reusable",
  databaseTest,
  async () => {
    const sql = createSql();
    const abort = new AbortController();
    let finished = false;
    try {
      await runWithRequestWork(abort.signal, async () => {
        void sql`select pg_sleep(0.03)`.then(() => {
          finished = true;
        });
        abort.abort();
      });
      assert.equal(finished, true);
      assert.equal(getSqlWorkStats(sql)?.active, 0);
      assert.equal((await sql`select 1 as value`)[0].value, 1);
    } finally {
      await sql.end();
    }
  },
);

test(
  "strict real transaction drains three queued queries and rollback after abort",
  databaseTest,
  async () => {
    const sql = createSql();
    const abort = new AbortController();
    let settled = 0;
    try {
      await sql`select 1`;
      const started = performance.now();
      await assert.rejects(
        runWithRequestWork(abort.signal, async () => {
          await sql.begin(async (tx) => {
            const queries = [
              tx.unsafe("select pg_sleep(5)"),
              tx.unsafe("select 2"),
              tx.unsafe("select 3"),
            ];
            for (const query of queries)
              void query.then(
                () => {
                  settled++;
                },
                () => {
                  settled++;
                },
              );
            await setTimeout(30);
            abort.abort();
            assert.equal(getSqlWorkStats(sql)?.active, 4);
            // Returning starts the child drain before native commit/rollback.
          });
        }),
        (error: unknown) =>
          error != null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "57014",
      );
      assert.equal(settled, 3);
      assert.ok(performance.now() - started < 2500);
      assert.equal(getSqlWorkStats(sql)?.active, 0);
      assert.equal((await sql`select 1 as value`)[0].value, 1);
    } finally {
      await sql.end();
    }
  },
);

test(
  "strict real server timeout records failure before the caller catches it",
  databaseTest,
  async () => {
    const sql = createSql();
    const abort = new AbortController();
    try {
      await runWithRequestWork(
        abort.signal,
        async () => {
          await assert.rejects(
            Promise.resolve(sql`select pg_sleep(5)`),
            (error: unknown) => {
              assert.equal(
                getRequestWorkOutcome().hardFailure?.kind,
                "timeout",
              );
              assert.equal(getRequestWorkOutcome().hardFailure?.error, error);
              return true;
            },
          );
          assert.equal(abort.signal.aborted, true);
        },
        { onFailure: (failure) => abort.abort(failure.error) },
      );
      assert.equal(getSqlWorkStats(sql)?.active, 0);
      assert.equal((await sql`select 1 as value`)[0].value, 1);
    } finally {
      await sql.end();
    }
  },
);

test(
  "strict real lock timeout and root notify are owned",
  databaseTest,
  async () => {
    const sql = createSql();
    const blocker = createSql();
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Session-local advisory locks avoid changing tables or application data.
    const key = Math.floor(Math.random() * 1_000_000_000);
    let transaction: Promise<unknown> | undefined;
    try {
      transaction = blocker.begin(async (tx) => {
        await tx.unsafe("select pg_advisory_xact_lock($1)", [key]);
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      await runWithRequestWork(new AbortController().signal, async () => {
        await assert.rejects(
          Promise.resolve(sql`select pg_advisory_xact_lock(${key})`),
          (error: unknown) => {
            assert.equal(getRequestWorkOutcome().hardFailure?.kind, "timeout");
            return (
              error != null &&
              typeof error === "object" &&
              "code" in error &&
              error.code === "55P03"
            );
          },
        );
      });
      release.resolve();
      await transaction;
      let delivered = false;
      await runWithRequestWork(new AbortController().signal, async () => {
        void sql.begin(async (tx) => {
          assert.throws(
            () => tx.notify("hackerspub_protocol_test", "unsupported"),
            /unavailable/,
          );
          await tx.unsafe("select 1");
          delivered = true;
        });
      });
      assert.equal(delivered, true);
      await runWithRequestWork(new AbortController().signal, async () => {
        void sql.notify("hackerspub_protocol_test", "owned");
      });
      assert.equal(getSqlWorkStats(sql)?.active, 0);
      assert.equal((await sql`select 1 as value`)[0].value, 1);
    } finally {
      release.resolve();
      await transaction?.catch(() => {});
      await Promise.all([sql.end(), blocker.end()]);
    }
  },
);

test(
  "strict real begin and nested savepoint preserve callback-returned arrays",
  databaseTest,
  async () => {
    const sql = createSql();
    try {
      const result = await sql.begin((tx) => [
        tx.unsafe("select 1 as value"),
        tx.savepoint((nested) => [nested.unsafe("select 2 as value")]),
      ]);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), [
        [{ value: 1 }],
        [[{ value: 2 }]],
      ]);
      assert.equal(getSqlWorkStats(sql)?.active, 0);
    } finally {
      await sql.end();
    }
  },
);
