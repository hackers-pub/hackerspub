import {
  getRequestWorkOutcome,
  runWithRequestWork,
  trackRequestWork,
} from "@hackerspub/models/request-work";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Sql } from "postgres";
import { getSqlWorkStats, trackSqlWork } from "./sql-work.ts";

class TestQuery extends Promise<unknown> {
  static get [Symbol.species]() {
    return Promise;
  }
  private start: () => void;
  cancellations = 0;
  constructor(action: () => Promise<unknown>) {
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    super((a, b) => {
      resolve = a;
      reject = b;
    });
    let started = false;
    this.start = () => {
      if (started) return;
      started = true;
      void action().then(resolve, reject);
    };
  }
  execute() {
    this.start();
    return this;
  }
  then<A = unknown, B = never>(
    fulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
    rejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    this.start();
    return super.then(fulfilled, rejected);
  }
  cancel() {
    this.cancellations++;
  }
  cursor() {
    this.start();
  }
  readable() {
    this.start();
  }
  writable() {
    this.start();
  }
}

function fakeSql(
  action: () => Promise<unknown>,
  methods: Record<string, unknown> = {},
): Sql {
  return Object.assign(() => new TestQuery(action), {
    unsafe: () => new TestQuery(action),
    ...methods,
  }) as unknown as Sql;
}

test("strict SQL budgets consumed startup work and rejects before starting excess", async () => {
  const pending = Promise.withResolvers<unknown>();
  let starts = 0;
  const sql = trackSqlWork(
    fakeSql(() => {
      starts++;
      return pending.promise;
    }),
    { strict: { limit: 1 } },
  );
  const first = sql.unsafe("first");
  const excess = sql.unsafe("excess");
  assert.equal(getSqlWorkStats(sql)?.active, 0);
  const result = first.then(() => {});
  assert.equal(starts, 1);
  await assert.rejects(Promise.resolve(excess), /work limit/);
  assert.deepEqual(getSqlWorkStats(sql), {
    active: 1,
    limit: 1,
    rejected: 1,
    nativeCancellations: 0,
  });
  pending.resolve("done");
  await result;
  await setImmediate();
  assert.equal(getSqlWorkStats(sql)?.active, 0);
});

test("strict abort retains consumed work without invoking native cancellation", async () => {
  const pending = Promise.withResolvers<unknown>();
  let starts = 0;
  const raw = new TestQuery(() => {
    starts++;
    return pending.promise;
  });
  const sql = trackSqlWork(
    Object.assign(() => raw, { unsafe: () => raw }) as unknown as Sql,
    {
      strict: { limit: 2 },
    },
  );
  const abort = new AbortController();
  let finished = false;
  const work = runWithRequestWork(abort.signal, async () => {
    sql.unsafe("active").execute();
    abort.abort();
  }).then(() => {
    finished = true;
  });
  await setImmediate();
  assert.equal(finished, false);
  assert.equal(starts, 1);
  assert.equal(raw.cancellations, 0);
  assert.equal(getSqlWorkStats(sql)?.active, 1);
  pending.resolve("done");
  await work;
  assert.equal(getSqlWorkStats(sql)?.active, 0);
});

test("strict overload reports before throwing and abort prevents new lazy execution", async () => {
  const pending = Promise.withResolvers<unknown>();
  let starts = 0;
  const sql = trackSqlWork(
    fakeSql(() => {
      starts++;
      return pending.promise;
    }),
    {
      strict: { limit: 1 },
    },
  );
  const abort = new AbortController();
  const work = runWithRequestWork(
    abort.signal,
    async () => {
      sql.unsafe("first").execute();
      await assert.rejects(Promise.resolve(sql.unsafe("excess")), /work limit/);
      assert.equal(getRequestWorkOutcome().hardFailure?.kind, "overload");
      await assert.rejects(
        Promise.resolve(sql.unsafe("after abort")),
        /work limit/,
      );
    },
    { onFailure: (failure) => abort.abort(failure.error) },
  );
  await setImmediate();
  assert.equal(starts, 1);
  assert.equal(getSqlWorkStats(sql)?.rejected, 1);
  pending.resolve("done");
  await work;
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    runWithRequestWork(cancelled.signal, async () => {
      await sql.unsafe("must not start");
    }),
    { name: "AbortError" },
  );
  assert.equal(starts, 1);
});

test("strict timeout is recorded before a caller catches the query error", async () => {
  for (const code of ["57014", "55P03"]) {
    const failure = Object.assign(new Error("server budget"), { code });
    const sql = trackSqlWork(
      fakeSql(() => Promise.reject(failure)),
      { strict: { limit: 2 } },
    );
    await runWithRequestWork(new AbortController().signal, async () => {
      try {
        await sql.unsafe("timeout");
        assert.fail("query must fail");
      } catch (error) {
        assert.equal(error, failure);
        assert.equal(getRequestWorkOutcome().hardFailure?.error, failure);
      }
    });
    assert.equal(getSqlWorkStats(sql)?.active, 0);
  }
});

test("strict transaction keeps its permit through callback drain and delayed commit", async () => {
  const query = Promise.withResolvers<unknown>();
  const commit = Promise.withResolvers<unknown>();
  const committing = Promise.withResolvers<void>();
  let childFinished = false;
  const tx = fakeSql(() => query.promise);
  const raw = fakeSql(() => Promise.resolve(), {
    begin: async (callback: (client: Sql) => Promise<unknown>) => {
      const result = await callback(tx);
      assert.equal(childFinished, true);
      committing.resolve();
      await commit.promise;
      return result;
    },
  });
  const sql = trackSqlWork(raw, { strict: { limit: 4 } });
  let settled = false;
  const work = runWithRequestWork(new AbortController().signal, async () => {
    void sql.begin((transaction) => {
      const running = transaction.unsafe("slow");
      void running.then(() => {
        childFinished = true;
      });
      return "value";
    });
  }).then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(getSqlWorkStats(sql)?.active, 2);
  assert.equal(settled, false);
  query.resolve("done");
  await committing.promise;
  assert.equal(getSqlWorkStats(sql)?.active, 1);
  assert.equal(settled, false);
  commit.resolve("done");
  await work;
  assert.equal(getSqlWorkStats(sql)?.active, 0);
});

test("strict transaction connection failure cannot abandon a still-running child", async () => {
  const child = Promise.withResolvers<void>();
  const callbackEntered = Promise.withResolvers<void>();
  const failure = new Error("connection closed");
  const tx = fakeSql(() => Promise.resolve());
  const raw = fakeSql(() => Promise.resolve(), {
    begin: (callback: (client: Sql) => Promise<unknown>) => {
      void callback(tx).catch(() => {});
      return Promise.reject(failure);
    },
  });
  const sql = trackSqlWork(raw, { strict: { limit: 2 } });
  let settled = false;
  const work = sql
    .begin(async () => {
      trackRequestWork(child.promise);
      callbackEntered.resolve();
    })
    .catch((error) => {
      assert.equal(error, failure);
      settled = true;
    });
  await callbackEntered.promise;
  await setImmediate();
  assert.equal(getSqlWorkStats(sql)?.active, 1);
  assert.equal(settled, false);
  child.resolve();
  await work;
  assert.equal(getSqlWorkStats(sql)?.active, 0);
});

test("strict callback failure owns rollback and preserves callback-array semantics", async () => {
  const rollback = Promise.withResolvers<void>();
  const rollingBack = Promise.withResolvers<void>();
  const tx = fakeSql(() => Promise.resolve("row"));
  Object.assign(tx, {
    savepoint: (callback: (client: Sql) => unknown) => callback(tx),
  });
  const raw = fakeSql(() => Promise.resolve(), {
    begin: async (callback: (client: Sql) => Promise<unknown>) => {
      try {
        return await callback(tx);
      } catch (error) {
        rollingBack.resolve();
        await rollback.promise;
        throw error;
      }
    },
  });
  const sql = trackSqlWork(raw, { strict: { limit: 8 } });
  const rows = await sql.begin((transaction) => [
    transaction.unsafe("first"),
    transaction.savepoint((nested) => [nested.unsafe("second")]),
  ]);
  assert.deepEqual(rows, ["row", ["row"]]);
  const failure = new Error("callback failed");
  let settled = false;
  const work = runWithRequestWork(new AbortController().signal, async () => {
    await sql.begin(async (transaction) => {
      transaction.unsafe("abandoned").execute();
      throw failure;
    });
  }).catch((error) => {
    assert.equal(error, failure);
    settled = true;
  });
  await rollingBack.promise;
  assert.equal(settled, false);
  assert.equal(getSqlWorkStats(sql)?.active, 1);
  rollback.resolve();
  await work;
  assert.equal(getSqlWorkStats(sql)?.active, 0);
});

test("strict notify admission and lifecycle include hidden native query work", async () => {
  const pending = Promise.withResolvers<unknown>();
  let notifications = 0;
  const sql = trackSqlWork(
    fakeSql(() => Promise.resolve(), {
      notify: () => {
        notifications++;
        return pending.promise;
      },
    }),
    { strict: { limit: 1 } },
  );
  let finished = false;
  const work = runWithRequestWork(new AbortController().signal, async () => {
    void sql.notify("channel", "payload");
    assert.throws(() => sql.notify("channel", "excess"), /work limit/);
  }).then(() => {
    finished = true;
  });
  await setImmediate();
  assert.equal(notifications, 1);
  assert.equal(finished, false);
  pending.resolve("done");
  await work;
  assert.equal(getSqlWorkStats(sql)?.active, 0);
});

test("strict clients reject resource and streaming escapes before execution", async () => {
  let starts = 0;
  const forbidden = () => {
    starts++;
  };
  const raw = fakeSql(
    async () => {
      starts++;
    },
    {
      reserve: forbidden,
      listen: forbidden,
      subscribe: forbidden,
      largeObject: forbidden,
      prepare: forbidden,
      savepoint: forbidden,
    },
  );
  const sql = trackSqlWork(raw, { strict: { limit: 2 } });
  for (const name of [
    "reserve",
    "listen",
    "subscribe",
    "largeObject",
    "prepare",
  ]) {
    assert.throws(
      () => Reflect.apply(Reflect.get(sql, name), sql, []),
      /unavailable/,
    );
  }
  const query = sql.unsafe("unused");
  for (const name of ["cancel", "cursor", "readable", "writable"]) {
    assert.throws(
      () => Reflect.apply(Reflect.get(query, name), query, []),
      /unavailable/,
    );
  }
  const template = Object.assign(["select ", ""], { raw: ["select ", ""] });
  assert.throws(
    () =>
      Reflect.apply(Reflect.get(sql, "savepoint"), sql, [template, () => {}]),
    /unavailable/,
  );
  assert.equal(starts, 0);
  assert.equal(getSqlWorkStats(sql)?.active, 0);
});
